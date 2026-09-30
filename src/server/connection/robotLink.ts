/**
 * TCP link to the ESP32-S3 robot.
 *
 * The robot speaks a raw binary protocol, not HTTP and not WebSocket, so
 * this uses a plain `net.Socket`. Responsibilities:
 *
 *  - connect, and reconnect with exponential backoff
 *  - frame the byte stream (a read can return half a packet, or three)
 *  - keep the robot's 700 ms safety watchdog fed while driving
 *  - never let the robot drive longer than the operator is holding
 *
 * The link is deliberately ignorant of the UI. It emits normalised state.
 */

import { EventEmitter } from "node:events";
import net from "node:net";
import {
  CMD,
  DEFAULT_ROBOT_PORT,
  ERR,
  FLAG_HELD,
  FrameReader,
  KEEPALIVE_INTERVAL_MS,
  MSG_TYPE,
  PING_INTERVAL_MS,
  ROBOT_STATE,
  ST,
  cliffIsDangerous,
  cliffName,
  errorMessage,
  isMotionCommand,
  remoteStateName,
  robotStateName,
  wheelsBlockedByVoice,
  encodePacket,
  encodeTextFrame,
  type CliffState,
  type DecodedPacket,
  type RobotStateName,
} from "../../shared/walleProtocol.js";
import type { ConnectionState, RobotStatus } from "../../shared/walleTypes.js";
import { EMPTY_STATUS } from "../../shared/walleTypes.js";

export interface RobotLinkOptions {
  reconnect: { enabled: boolean; minDelayMs: number; maxDelayMs: number };
  /** Optional bearer secret, if the robot ever requires one. */
  token?: string;
  /** Keepalive tuning; defaults come from the protocol constants. */
  keepalive?: { heldMs: number; pingMs: number };
  /** Injected in tests. */
  createSocket?: (host: string, port: number) => net.Socket;
}

export interface RobotLinkEvents {
  state: (state: ConnectionState, error?: { code: string; message: string }) => void;
  status: (status: RobotStatus) => void;
  /** A human-readable line for the activity feed. */
  log: (level: "debug" | "info" | "warn" | "error", message: string) => void;
  /** WALL-E's spoken answer, from a TEXT reply frame. */
  reply: (text: string) => void;
  /** The robot refused a command. `code` is a firmware ErrorId. */
  refused: (code: number, message: string) => void;
  /**
   * Why the robot will not move right now, or null when it can.
   *
   * Distinct from `refused`: a refusal is a response to a command, while
   * this is a persistent condition the operator needs to see until it clears.
   */
  blocked: (reason: string | null) => void;
  /** Any acknowledgement of a command. */
  ack: (commandId: number) => void;
  /** Raw text frame, for the activity feed. */
  text: (op: string, text: string) => void;
}

export declare interface RobotLink {
  on<K extends keyof RobotLinkEvents>(event: K, listener: RobotLinkEvents[K]): this;
  emit<K extends keyof RobotLinkEvents>(event: K, ...args: Parameters<RobotLinkEvents[K]>): boolean;
}

export class RobotLink extends EventEmitter {
  private socket: net.Socket | null = null;
  private reader = new FrameReader();
  private seq = 0;
  private attempts = 0;
  private state: ConnectionState = "disconnected";
  private host: string | null = null;
  private port = DEFAULT_ROBOT_PORT;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private stopped = true;

  /** The direction currently held by the operator, if any. */
  private heldCommand: number | null = null;

  private status: RobotStatus = { ...EMPTY_STATUS };

  /** When true, the operator is driving; keeps the watchdog fed. */
  private driving = false;
  /** Set when the robot refuses movement because it is talking. */
  private blockedReason: string | null = null;

  constructor(private readonly opts: RobotLinkOptions) {
    super();
    this.setMaxListeners(50);
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get robotStatus(): RobotStatus {
    return { ...this.status };
  }

  get target(): { host: string; port: number } | null {
    return this.host ? { host: this.host, port: this.port } : null;
  }

  get isDriving(): boolean {
    return this.driving;
  }

  get blocked(): string | null {
    return this.blockedReason;
  }

  /* ------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------ */

  connect(host: string, port: number = DEFAULT_ROBOT_PORT): void {
    const trimmed = host.trim();
    if (!trimmed) return;
    this.host = trimmed;
    this.port = port;
    this.attempts = 0;
    this.stopped = false;
    this.clearReconnect();
    this.open();
  }

  disconnect(reason = "client requested"): void {
    this.stopped = true;
    this.clearReconnect();
    this.stopKeepalive();
    // A polite goodbye: the robot stops immediately on BYE.
    if (this.socket && this.state === "connected") {
      this.raw(encodePacket({ type: MSG_TYPE.COMMAND, cmd: CMD.BYE }, this.nextSeq()));
      // Let the queued write reach the robot before the socket goes away.
      // end() flushes, but the mock and the ESP32 both need a moment, so the
      // teardown is deferred by one tick rather than done synchronously.
      const sock = this.socket;
      setTimeout(() => this.teardown(sock), 50);
    } else {
      this.teardown();
    }
    this.heldCommand = null;
    this.driving = false;
    this.setStatus({ ...this.status, appHasControl: false });
    this.emit("log", "info", `disconnected (${reason})`);
    this.setState("disconnected");
  }

  private open(): void {
    if (!this.host || this.socket) return;

    this.setState(this.attempts === 0 ? "connecting" : "reconnecting");

    const factory = this.opts.createSocket ?? ((h: string, p: number) => {
      const s = new net.Socket();
      // The constructor form does not connect; connect() below starts the
      // handshake. Using the 2-arg form would open the socket twice.
      s.connect(p, h);
      return s;
    });
    let socket: net.Socket;
    try {
      socket = factory(this.host, this.port);
    } catch (err) {
      this.emit("log", "error", `socket creation failed: ${(err as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.reader.reset();
    socket.setNoDelay(true); // frames are 10 bytes; Nagle only adds latency

    // A fresh socket carries no error/close listeners, so an unattached one
    // that is later destroyed emits an unhandled 'error' and takes the
    // process down. A no-op listener is the standard guard.
    socket.on("error", () => {});

    socket.once("connect", () => {
      this.attempts = 0;
      this.emit("log", "info", `connected to ${this.host}:${this.port}`);
      this.setState("connected");
      this.hello();
      // Ask once up front so the cliff readout is not blank on arrival.
      this.readSensor();
    });

    socket.on("data", (chunk: Buffer) => this.ingest(chunk));

    socket.on("error", (err: Error) => {
      this.emit("log", "error", `socket error: ${err.message}`);
      this.setState("error", { code: "E_INTERNAL", message: err.message });
    });

    socket.on("close", () => {
      this.emit("log", "warn", "connection closed by peer");
      this.stopKeepalive();
      this.heldCommand = null;
      this.driving = false;
      this.teardown(socket);
      this.setStatus({ ...this.status, appHasControl: false });
      this.setState("disconnected");
      this.scheduleReconnect();
    });
  }

  /** Close the socket, detaching first so our own handler does not fire. */
  private teardown(expect: net.Socket | null = this.socket): void {
    if (this.socket === expect) this.socket = null;
    if (!expect) return;
    try {
      // Detach first so our own close handler does not schedule a reconnect.
      expect.removeAllListeners();
      expect.destroy();
    } catch {
      /* already closing */
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.opts.reconnect.enabled || !this.host) return;
    this.clearReconnect();
    const delay = Math.min(
      this.opts.reconnect.maxDelayMs,
      this.opts.reconnect.minDelayMs * 2 ** this.attempts,
    );
    this.attempts += 1;
    this.emit("log", "info", `reconnecting in ${delay}ms (attempt ${this.attempts})`);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /* ------------------------------------------------------------ *
   * Inbound
   * ------------------------------------------------------------ */

  private ingest(chunk: Buffer): void {
    const { packets, texts } = this.reader.feed(new Uint8Array(chunk));

    for (const text of texts) {
      const opName = text.op === 0x03 ? "reply" : text.op === 0x02 ? "speak" : "ask";
      this.emit("text", opName, text.text);
      if (text.op === 0x03) this.emit("reply", text.text);
    }

    for (const p of packets) this.onPacket(p);
  }

  private onPacket(p: DecodedPacket): void {
    if (p.type !== MSG_TYPE.STATUS) return;

    switch (p.cmd) {
      case ST.WELCOME:
      case ST.PONG:
      case ST.ROBOT_STATE:
        this.applyState(p.value);
        break;

      case ST.ACK:
        // An ack means the robot took the command; drop any block notice.
        if (this.blockedReason) this.setBlocked(null);
        this.emit("ack", p.cmd === ST.ACK ? p.value : p.cmd);
        if (isMotionCommand(p.value)) this.driving = true;
        break;

      case ST.ERROR:
        this.onRefusal(p.value);
        break;

      case ST.SENSOR:
      case ST.CLIFF:
        this.applyCliff(p.value, p.arg);
        break;

      case ST.REMOTE_STATE:
        this.setStatus({ ...this.status, remoteState: remoteStateName(p.value) });
        this.emit("log", "debug", `radio remote: ${remoteStateName(p.value)}`);
        break;

      case ST.BATTERY:
        // The current firmware never sends this, but if a battery is ever
        // fitted the app will start showing it with no further changes.
        this.setStatus(
          p.arg > 0
            ? { ...this.status, batteryMillivolts: p.arg }
            : { ...this.status, batteryMillivolts: undefined },
        );
        break;

      default:
        this.emit("log", "debug", `unhandled status 0x${p.cmd.toString(16)}`);
    }
  }

  private onRefusal(code: number): void {
    const message = errorMessage(code);

    // LINK_TIMEOUT is the robot complaining about US, not refusing a command.
    // Re-arm the keepalive rather than tearing the connection down.
    if (code === ERR.LINK_TIMEOUT) {
      this.emit("refused", code, message);
      this.setBlocked(message);
      this.driving = false;
      this.heldCommand = null;
      this.emit("log", "warn", `${message} — resuming keepalive`);
      return;
    }

    // CLIFF and SENSOR_FAULT are a stop condition, not a retry condition.
    if (code === ERR.CLIFF || code === ERR.SENSOR_FAULT) {
      this.emit("refused", code, message);
      this.setBlocked(message);
      this.driving = false;
      this.heldCommand = null;
      this.emit("log", "warn", message);
      return;
    }

    this.emit("refused", code, message);
    this.emit("log", "warn", message);
  }

  private applyState(value: number): void {
    const name = robotStateName(value) as RobotStateName;
    const blocked = wheelsBlockedByVoice(value);
    // REMOTE means "a controller owns the wheels". Anything else means the
    // robot is doing its own thing and our held command is over.
    const controllerOwnsWheels = value === ROBOT_STATE.REMOTE;

    this.setStatus({
      ...this.status,
      state: name,
      stateCode: value,
      appHasControl: controllerOwnsWheels,
      remoteHasControl: false,
      autonomous: value === ROBOT_STATE.EXPLORING || value === ROBOT_STATE.OBSERVING,
      wheelsBlocked: blocked,
    });

    if (blocked) {
      this.setBlocked("WALL-E is thinking or speaking — wheels locked");
    } else if (this.blockedReason?.includes("wheels locked")) {
      this.setBlocked(null);
    }

    // The robot left REMOTE, so a held direction is over even if the
    // operator's finger has not lifted yet.
    if (!controllerOwnsWheels && this.driving) {
      this.driving = false;
      this.heldCommand = null;
    }
  }

  private applyCliff(value: number, groundCm: number): void {
    const dangerous = cliffIsDangerous(value);
    this.setStatus({
      ...this.status,
      cliff: value as CliffState,
      cliffName: cliffName(value),
      groundCm,
    });
    if (dangerous) {
      this.driving = false;
      this.heldCommand = null;
      this.setBlocked(
        value === 3 ? "WALL-E stopped: no floor ahead" : "WALL-E stopped: sensor not responding",
      );
    } else if (this.blockedReason?.includes("WALL-E stopped")) {
      this.setBlocked(null);
    }
  }

  private setStatus(status: RobotStatus): void {
    this.status = status;
    this.emit("status", { ...status });
  }

  /**
   * Record why the robot will not move right now.
   *
   * This emits, because a refusal the operator cannot see is a robot that
   * silently will not move. The server republishes state on the event, so
   * the UI explains the refusal without waiting for the next unrelated
   * status frame to happen to arrive.
   */
  private setBlocked(reason: string | null): void {
    if (this.blockedReason === reason) return;
    this.blockedReason = reason;
    this.emit("blocked", reason);
  }

  private setState(state: ConnectionState, error?: { code: string; message: string }): void {
    if (this.state === state && !error) return;
    this.state = state;
    this.emit("state", state, error);
  }

  /* ------------------------------------------------------------ *
   * Outbound
   * ------------------------------------------------------------ */

  private nextSeq(): number {
    this.seq = (this.seq + 1) & 0xff;
    return this.seq;
  }

  private raw(bytes: Uint8Array): boolean {
    if (!this.socket || this.state !== "connected") return false;
    try {
      this.socket.write(Buffer.from(bytes));
      return true;
    } catch (err) {
      this.emit("log", "error", `write failed: ${(err as Error).message}`);
      return false;
    }
  }

  private send(cmd: number, arg = 0, held = false, value = 0): boolean {
    return this.raw(
      encodePacket(
        { type: MSG_TYPE.COMMAND, cmd, value, flags: held ? FLAG_HELD : 0, arg },
        this.nextSeq(),
      ),
    );
  }

  private sendText(op: number, text: string): boolean {
    return this.raw(encodeTextFrame(op, text));
  }

  /**
   * Ask the robot to introduce itself. Sent automatically on connect, which
   * is what makes the robot's state known before the operator touches
   * anything.
   */
  hello(): boolean {
    this.emit("log", "debug", "hello");
    return this.send(CMD.HELLO);
  }

  ping(): boolean {
    return this.send(CMD.PING);
  }

  bye(): boolean {
    return this.send(CMD.BYE);
  }

  /**
   * Hold or release a direction.
   *
   * Pressing arms the keepalive; releasing sends `stop` and disarms it. This
   * is the single most safety-critical call in the app, which is why the
   * operator's finger leaving the joystick is the thing that stops the robot.
   */
  drive(command: number, held: boolean): boolean {
    if (held) {
      this.heldCommand = command;
      this.driving = true;
      this.startKeepalive();
      return this.send(command, 0, true);
    }
    this.heldCommand = null;
    this.driving = false;
    this.stopKeepalive();
    // stop is never held, and is always safe to send.
    return this.send(CMD.STOP);
  }

  /** Force a stop and disarm the keepalive. */
  stop(): boolean {
    this.heldCommand = null;
    this.driving = false;
    this.stopKeepalive();
    return this.send(CMD.STOP);
  }

  /* ------------------------------------------------------------ *
   * Keepalive — the 700 ms watchdog
   * ------------------------------------------------------------ */

  private startKeepalive(): void {
    if (this.keepaliveTimer) return;
    this.keepaliveTimer = setInterval(() => {
      if (this.state !== "connected") return;
      // Re-send the held command, exactly as the radio remote does. The
      // robot stops itself if these stop arriving.
      if (this.heldCommand !== null) this.send(this.heldCommand, 0, true);
      else this.send(CMD.PING);
    }, this.opts.keepalive?.heldMs ?? KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  /** Idle keepalive, so a connected-but-still link is not dropped. */
  startIdleKeepalive(): void {
    if (this.keepaliveTimer) return;
    this.keepaliveTimer = setInterval(() => {
      if (this.state === "connected" && !this.driving) this.ping();
    }, this.opts.keepalive?.pingMs ?? PING_INTERVAL_MS);
  }

  /* ------------------------------------------------------------ *
   * Higher-level commands
   * ------------------------------------------------------------ */

  simple(command: number): boolean {
    return this.send(command);
  }

  moveSteps(steps: number): boolean {
    // No keepalive: the robot finishes this on its own.
    return this.send(CMD.MOVE_STEPS, steps);
  }

  turnDegrees(degrees: number): boolean {
    return this.send(CMD.TURN_DEGREES, degrees);
  }

  turnAround(): boolean {
    return this.send(CMD.TURN_AROUND);
  }

  readSensor(): boolean {
    return this.send(CMD.READ_SENSOR);
  }

  setAutonomous(enabled: boolean): boolean {
    return this.send(enabled ? CMD.AUTONOMOUS_ON : CMD.AUTONOMOUS_OFF);
  }

  setExpression(command: number): boolean {
    return this.send(command);
  }

  /** Announce `ask`, then immediately send the words. Order matters. */
  ask(text: string): boolean {
    if (!this.send(CMD.ASK)) return false;
    return this.sendText(0x01, text);
  }

  /** Announce `speak`, then immediately send the words. */
  speak(text: string): boolean {
    if (!this.send(CMD.SPEAK)) return false;
    return this.sendText(0x02, text);
  }
}
