/**
 * In-process simulator of the ESP32-S3 WALL-E robot.
 *
 * Speaks the real binary protocol over a real TCP server, so the app, the
 * framing code and the command semantics are all exercised exactly as they
 * will be against the hardware. It also reproduces the robot's safety rules,
 * because a simulator that let you drive off a table would be worse than
 * useless for a demo.
 */

import net from "node:net";
import {
  CLIFF,
  CMD,
  ERR,
  FLAG_HELD,
  FrameReader,
  MAGIC,
  MSG_TYPE,
  ROBOT_STATE,
  ST,
  VERSION,
  cliffIsDangerous,
  encodePacket,
  robotStateName,
  wheelsBlockedByVoice,
  type DecodedPacket,
} from "../shared/walleProtocol.js";

export interface MockRobotOptions {
  port?: number;
  host?: string;
  name?: string;
  /** Override the cliff sensor, e.g. to rehearse an edge refusal on stage. */
  cliff?: number;
  groundCm?: number;
  onPacket?: (p: DecodedPacket) => void;
}

const SAMPLE_NOMINAL_GROUND_CM = 12;

export class MockRobot {
  private server: net.Server | null = null;
  private client: net.Socket | null = null;
  private reader = new FrameReader();
  private txSeq = 0;

  private state: number = ROBOT_STATE.IDLE;
  private heldFromApp: number | null = null;
  private appLastRx = 0;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private danceTimer: NodeJS.Timeout | null = null;
  private maneuverTimer: NodeJS.Timeout | null = null;
  private ttsTimer: NodeJS.Timeout | null = null;
  private exploreTimer: NodeJS.Timeout | null = null;
  private stateTimer: NodeJS.Timeout | null = null;
  private pendingTextCmd: number | null = null;

  private cliff: number;
  private groundCm: number;

  constructor(private readonly opts: MockRobotOptions = {}) {
    this.cliff = opts.cliff ?? CLIFF.GROUND;
    this.groundCm = opts.groundCm ?? SAMPLE_NOMINAL_GROUND_CM;
  }

  async start(): Promise<number> {
    this.server = net.createServer((socket) => this.onConnection(socket));
    await new Promise<void>((done) =>
      this.server!.listen(this.opts.port ?? 0, this.opts.host ?? "127.0.0.1", done),
    );
    const addr = this.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    // The real robot pushes its state about once a second as a keepalive
    // floor, and the integration doc explicitly warns the app not to treat
    // every one of those as a screen update. The simulator does the same so
    // that behaviour is developed against.
    this.stateTimer = setInterval(() => this.sendStatus(ST.ROBOT_STATE, this.state), 1000);
    return port;
  }

  private onConnection(socket: net.Socket): void {
    this.client = socket;
    socket.setNoDelay(true);
    this.reader.reset();
    this.heldFromApp = null;
    this.appLastRx = Date.now();

    // The robot greets a new controller immediately.
    this.sendStatus(ST.WELCOME, this.state);
    this.startWatchdog();

    socket.on("data", (chunk) => this.ingest(chunk));
    socket.on("close", () => {
      if (this.client === socket) this.client = null;
      this.releaseWheels("app disconnected");
      this.stopWatchdog();
    });
    socket.on("error", () => this.releaseWheels("socket error"));
  }

  private ingest(chunk: Buffer): void {
    const { packets, texts } = this.reader.feed(new Uint8Array(chunk));
    for (const p of packets) {
      this.appLastRx = Date.now();
      this.onPacket(p);
    }
    for (const t of texts) {
      this.appLastRx = Date.now();
      this.onTextFrame(t.op, t.text);
    }
  }

  /* ------------------------------------------------------------ *
   * Command handling
   * ------------------------------------------------------------ */

  private onPacket(p: DecodedPacket): void {
    this.opts.onPacket?.(p);
    if (p.type !== MSG_TYPE.COMMAND) return;

    const cmd = p.cmd;
    const held = (p.flags & FLAG_HELD) !== 0;

    switch (cmd) {
      case CMD.HELLO:
        this.sendStatus(ST.WELCOME, this.state);
        return;

      case CMD.PING:
        this.sendStatus(ST.PONG, this.state);
        return;

      case CMD.BYE:
        this.releaseWheels("bye");
        this.setState(ROBOT_STATE.IDLE);
        return;

      // ---- P0: never refused, never queued ----
      case CMD.STOP:
        this.releaseWheels("stop");
        this.sendAck(cmd);
        return;
      case CMD.IDLE:
        this.cancelAll();
        this.setState(ROBOT_STATE.IDLE);
        this.sendAck(cmd);
        return;

      // ---- held directions ----
      case CMD.MOVE_FORWARD:
      case CMD.MOVE_BACKWARD:
      case CMD.TURN_LEFT:
      case CMD.TURN_RIGHT:
      case CMD.ROTATE_LEFT:
      case CMD.ROTATE_RIGHT:
        this.handleDrive(cmd, held);
        return;

      // ---- timed motions ----
      case CMD.MOVE_STEPS:
        this.runManeuver(() => this.setState(ROBOT_STATE.MOVING), 400 + p.arg * 100, () =>
          this.setState(ROBOT_STATE.IDLE),
        );
        this.sendAck(cmd);
        return;

      case CMD.TURN_DEGREES:
        if (p.arg < 1 || p.arg > 360) return this.sendError(ERR.BAD_ARG);
        this.runManeuver(
          () => this.setState(ROBOT_STATE.MOVING),
          Math.max(120, (p.arg / 360) * 1400),
          () => this.setState(ROBOT_STATE.IDLE),
        );
        this.sendAck(cmd);
        return;

      case CMD.TURN_AROUND:
        this.runManeuver(
          () => this.setState(ROBOT_STATE.MOVING),
          700,
          () => this.setState(ROBOT_STATE.IDLE),
        );
        this.sendAck(cmd);
        return;

      // ---- modes ----
      case CMD.DANCE:
        this.cancelAll();
        this.setState(ROBOT_STATE.DANCING);
        this.sendAck(cmd);
        this.danceTimer = setTimeout(() => {
          this.danceTimer = null;
          this.setState(ROBOT_STATE.IDLE);
        }, 4000);
        return;

      case CMD.EXPLORE:
        this.cancelAll();
        this.setState(ROBOT_STATE.EXPLORING);
        this.sendAck(cmd);
        this.exploreTimer = setTimeout(() => {
          this.exploreTimer = null;
          this.setState(ROBOT_STATE.IDLE);
        }, 8000);
        return;

      case CMD.AUTONOMOUS_ON:
        // The real robot drives itself when autonomous is on, and that shows
        // up as the EXPLORING state the app already understands.
        this.setState(ROBOT_STATE.EXPLORING);
        this.sendAck(cmd);
        return;

      case CMD.AUTONOMOUS_OFF:
        this.releaseWheels("autonomous off");
        this.setState(ROBOT_STATE.IDLE);
        this.sendAck(cmd);
        return;

      // ---- expressions ----
      case CMD.EXPR_HAPPY:
      case CMD.EXPR_THINKING:
      case CMD.EXPR_SURPRISED:
      case CMD.EXPR_CONFUSED:
      case CMD.EXPR_IDLE:
        this.sendAck(cmd);
        return;

      // ---- sensors ----
      case CMD.READ_SENSOR:
        this.sendStatus(ST.SENSOR, this.cliff, this.groundCm);
        this.sendAck(cmd);
        return;

      // ---- voice, no text frame needed ----
      case CMD.TALK:
        this.voiceExchange("Hello! I am WALL-E. What can I do for you?");
        this.sendAck(cmd);
        return;

      case CMD.JOKE:
        this.voiceExchange("Why did the robot cross the road? To reach the other charging station!");
        this.sendAck(cmd);
        return;

      // ---- ask / speak: the text frame follows ----
      case CMD.ASK:
      case CMD.SPEAK:
        this.pendingTextCmd = cmd;
        this.sendAck(cmd);
        return;

      default:
        this.sendError(ERR.UNKNOWN_CMD);
    }
  }

  private onTextFrame(op: number, text: string): void {
    // Only a reply op from the robot side is expected on this path.
    if (op !== 0x01 && op !== 0x02) return;
    const cmd = this.pendingTextCmd;
    this.pendingTextCmd = null;
    if (cmd === CMD.ASK) this.voiceExchange(this.replyTo(text));
    else this.voiceExchange(text);
  }

  private handleDrive(cmd: number, held: boolean): void {
    // SAFETY FIRST, above every priority rule in the dispatch table.
    if (wheelsBlockedByVoice(this.state)) {
      this.sendError(ERR.BUSY);
      return;
    }
    if (this.cliffIsBad()) {
      this.sendError(this.cliff === CLIFF.FAULT ? ERR.SENSOR_FAULT : ERR.CLIFF);
      return;
    }

    if (held) {
      this.heldFromApp = cmd;
      this.setState(ROBOT_STATE.REMOTE);
      this.sendAck(cmd);
      return;
    }

    // A direction arriving without HELD is treated as a tap: drive briefly,
    // then stop on its own, which is what the real robot does.
    this.heldFromApp = null;
    this.setState(ROBOT_STATE.MOVING);
    this.sendAck(cmd);
    this.maneuverTimer = setTimeout(() => {
      this.maneuverTimer = null;
      this.setState(ROBOT_STATE.IDLE);
    }, 500);
  }

  private runManeuver(start: () => void, ms: number, end: () => void): void {
    if (wheelsBlockedByVoice(this.state)) return this.sendError(ERR.BUSY);
    if (this.cliffIsBad()) {
      return this.sendError(this.cliff === CLIFF.FAULT ? ERR.SENSOR_FAULT : ERR.CLIFF);
    }
    this.cancelManeuver();
    start();
    this.maneuverTimer = setTimeout(() => {
      this.maneuverTimer = null;
      end();
    }, ms);
  }

  private voiceExchange(text: string): void {
    this.cancelTts();
    this.setState(ROBOT_STATE.THINKING);
    // The real robot goes to Gemini first, then speaks.
    this.ttsTimer = setTimeout(() => {
      this.sendText(0x03, text);
      this.setState(ROBOT_STATE.SPEAKING);
      this.ttsTimer = setTimeout(() => {
        this.ttsTimer = null;
        this.setState(ROBOT_STATE.IDLE);
      }, Math.min(2500, 400 + text.length * 25));
    }, 600);
  }

  private replyTo(question: string): string {
    const q = question.toLowerCase();
    if (q.includes("joke")) return "Why did the robot cross the road? To reach the other charging station!";
    if (q.includes("who") && q.includes("you")) return "I am WALL-E, a compacting robot with a very curious mind!";
    if (q.includes("edge") || q.includes("table")) return "My distance sensor watches the floor so I never walk off the edge!";
    if (q.includes("name")) return "My name is WALL-E!";
    if (q.includes("hello") || q.includes("hi")) return "Hello there! WALL-E here, ready to roll!";
    if (q.includes("remote") || q.includes("app")) return "You are talking to me through the app link on port 8080!";
    return "Beep boop! I heard you. WALL-E is online and ready to explore!";
  }

  /* ------------------------------------------------------------ *
   * Safety
   * ------------------------------------------------------------ */

  private cliffIsBad(): boolean {
    return cliffIsDangerous(this.cliff);
  }

  /**
   * The 700 ms watchdog. While the app owns the wheels, silence from the app
   * stops the robot. This is the single most important behaviour to simulate
   * faithfully: it is what stops a robot whose phone screen locked.
   */
  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(() => {
      if (this.heldFromApp === null) return;
      if (Date.now() - this.appLastRx > 700) {
        this.heldFromApp = null;
        this.sendError(ERR.LINK_TIMEOUT);
        this.setState(ROBOT_STATE.IDLE);
      }
    }, 100);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private releaseWheels(reason: string): void {
    void reason;
    this.heldFromApp = null;
    this.cancelManeuver();
  }

  private cancelManeuver(): void {
    if (this.maneuverTimer) {
      clearTimeout(this.maneuverTimer);
      this.maneuverTimer = null;
    }
  }

  private cancelTts(): void {
    if (this.ttsTimer) {
      clearTimeout(this.ttsTimer);
      this.ttsTimer = null;
    }
  }

  private cancelAll(): void {
    this.releaseWheels("cancelled");
    this.cancelTts();
    if (this.danceTimer) {
      clearTimeout(this.danceTimer);
      this.danceTimer = null;
    }
    if (this.exploreTimer) {
      clearTimeout(this.exploreTimer);
      this.exploreTimer = null;
    }
  }

  /* ------------------------------------------------------------ *
   * Outbound
   * ------------------------------------------------------------ */

  private setState(next: number): void {
    if (this.state === next) return;
    this.state = next;
    this.sendStatus(ST.ROBOT_STATE, this.state);
  }

  private sendStatus(status: number, value = 0, arg = 0): void {
    this.send({ type: MSG_TYPE.STATUS, cmd: status, value, arg });
  }

  private sendAck(command: number): void {
    // ACK carries the command that ran, per the integration doc.
    this.send({ type: MSG_TYPE.STATUS, cmd: ST.ACK, value: command });
  }

  private sendError(err: number): void {
    this.send({ type: MSG_TYPE.STATUS, cmd: ST.ERROR, value: err });
  }

  private sendText(op: number, text: string): void {
    const bytes = new TextEncoder().encode(text);
    const b = Buffer.alloc(8 + bytes.length);
    b[0] = MAGIC;
    b[1] = VERSION;
    b[2] = MSG_TYPE.TEXT;
    b[3] = op;
    b[4] = 0;
    b.writeUInt16LE(bytes.length, 5);
    b[7] = 0;
    Buffer.from(bytes).copy(b, 8);
    this.write(b);
  }

  private send(f: { type: number; cmd: number; value?: number; arg?: number }): void {
    this.txSeq = (this.txSeq + 1) & 0xff;
    const bytes = encodePacket(
      { type: f.type, cmd: f.cmd, value: f.value ?? 0, arg: f.arg ?? 0, seq: this.txSeq },
      this.txSeq,
    );
    this.write(Buffer.from(bytes));
  }

  private write(buf: Buffer): void {
    if (this.client) this.client.write(buf);
  }

  /** Current state name, for tests and the status endpoint. */
  get stateName(): string {
    return robotStateName(this.state);
  }

  get isDriving(): boolean {
    return this.heldFromApp !== null;
  }

  get cliffState(): number {
    return this.cliff;
  }

  /**
   * Simulate driving up to a table edge, for a live demo rehearsal.
   *
   * A cliff or a sensor fault is a stop condition in its own right, not just
   * a reason to refuse the next command, so the real robot reports it as an
   * ERROR and releases the wheels. This does the same.
   */
  setCliff(next: number, groundCm?: number): void {
    this.cliff = next;
    if (groundCm !== undefined) this.groundCm = groundCm;
    this.sendStatus(ST.CLIFF, this.cliff, this.groundCm);

    // Reported every time it is unsafe, not only on the transition. A real
    // robot that keeps seeing a drop keeps refusing to drive, and re-asserting
    // the refusal makes the simulator idempotent — setting DROP twice says
    // DROP twice, so a test that arrives late cannot silently inherit a
    // previous test's state.
    if (cliffIsDangerous(next)) {
      this.releaseWheels("cliff detected");
      this.setState(ROBOT_STATE.IDLE);
      this.sendError(next === CLIFF.FAULT ? ERR.SENSOR_FAULT : ERR.CLIFF);
    }
  }

  async stop(): Promise<void> {
    this.cancelAll();
    this.stopWatchdog();
    if (this.stateTimer) clearInterval(this.stateTimer);
    this.client?.destroy();
    await new Promise<void>((done) => {
      if (!this.server) return done();
      this.server.close(() => done());
    });
    this.server = null;
  }
}
