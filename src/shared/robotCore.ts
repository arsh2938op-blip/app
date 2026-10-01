/**
 * RobotCore — the WALL-E protocol, with no socket attached.
 *
 * Everything that decides what a byte means, when to send it and what the
 * robot is doing lives here. The socket is deliberately left out, because the
 * same logic has to run in two very different places:
 *
 *   - in the Node companion server, over a `net.Socket`
 *   - on the phone, over the Capacitor plugin's raw TCP socket
 *
 * Keeping it here means the on-device app runs the identical, tested code
 * rather than a second implementation that quietly drifts.
 *
 * Nothing in this file touches the network, a timer is only ever an interval
 * that this class owns, and there is no reference to Node or to the DOM.
 */

import {
  CLIFF,
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
  TEXT_MAX,
  cliffIsDangerous,
  cliffName,
  encodePacket,
  encodeTextFrame,
  errorMessage,
  isMotionCommand,
  remoteStateName,
  robotStateName,
  wheelsBlockedByVoice,
  type CliffState,
  type DecodedPacket,
  type RobotStateName,
} from "./walleProtocol.js";
import { EMPTY_STATUS, type ConnectionState, type RobotStatus } from "./walleTypes.js";
import { personaPayload } from "./persona.js";

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

/**
 * The only thing RobotCore needs from the outside world.
 *
 * Deliberately small. Anything smarter — framing, keepalive, reconnects —
 * would be logic that then exists twice and has to be kept in step.
 */
export interface ByteTransport {
  /** Open the connection. Rejects on failure; does not auto-retry. */
  open(host: string, port: number): Promise<void>;
  /** Write bytes. Returns false if the transport is not usable. */
  write(bytes: Uint8Array): boolean;
  /** Close. Must be safe to call more than once. */
  close(): void;
}

/**
 * Why WALL-E can refuse to move. Each cause has exactly one way to clear,
 * which is why the cause is tracked rather than the message: matching on the
 * text meant a block raised by an ERROR frame outlived the fault.
 */
export type BlockCause = "cliff" | "sensor-fault" | "voice" | "link-timeout";

export interface RobotCoreHandlers {
  onState?: (state: ConnectionState, error?: { code: string; message: string }) => void;
  onStatus?: (status: RobotStatus) => void;
  onLog?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
  onReply?: (text: string) => void;
  onRefused?: (code: number, message: string) => void;
  onBlocked?: (reason: string | null) => void;
  onAck?: (commandId: number) => void;
  onText?: (op: string, text: string) => void;
}

export interface RobotCoreOptions {
  reconnect: { enabled: boolean; minDelayMs: number; maxDelayMs: number };
  keepalive?: { heldMs: number; pingMs: number };
}

export class RobotCore {
  private reader = new FrameReader();
  private seq = 0;
  private attempts = 0;
  private state: ConnectionState = "disconnected";
  private host: string | null = null;
  private port = DEFAULT_ROBOT_PORT;
  private stopped = true;
  /** The live socket, or null while disconnected. */
  private link: ByteTransport | null = null;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  /** The direction currently held by the operator, if any. */
  private heldCommand: number | null = null;
  private blockCause: BlockCause | null = null;
  private blockMessage: string | null = null;
  private status: RobotStatus = { ...EMPTY_STATUS };
  private driving = false;

  constructor(
    private transport: ByteTransport,
    private readonly opts: RobotCoreOptions,
    private readonly handlers: RobotCoreHandlers = {},
  ) {}

  /* ------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------ */

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
    return this.blockMessage;
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
    void this.open();
  }

  disconnect(reason = "client requested"): void {
    this.stopped = true;
    this.clearReconnect();
    this.stopKeepalive();
    if (this.state === "connected") {
      // A polite goodbye: the robot stops immediately on BYE.
      this.write(encodePacket({ type: MSG_TYPE.COMMAND, cmd: CMD.BYE }, this.nextSeq()));
      // Flush before closing. The write is queued, not instantaneous, so the
      // close is deferred rather than done synchronously.
      setTimeout(() => this.teardown(), 50);
    } else {
      this.teardown();
    }
    this.heldCommand = null;
    this.driving = false;
    this.setStatus({ ...this.status, appHasControl: false });
    this.log("info", `disconnected (${reason})`);
    this.setState("disconnected");
  }

  private async open(): Promise<void> {
    if (!this.host || this.link) return;

    this.setState(this.attempts === 0 ? "connecting" : "reconnecting");
    this.reader.reset();

    try {
      await this.transport.open(this.host, this.port);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log("error", `connect failed: ${message}`);
      this.teardown();
      this.setState("error", { code: "E_INTERNAL", message });
      this.scheduleReconnect();
      return;
    }

    this.attempts = 0;
    // Mark the link live only once the handshake actually succeeded, so a
    // failed connect can never accept a write.
    this.link = this.transport;
    this.log("info", `connected to ${this.host}:${this.port}`);
    this.setState("connected");
    this.hello();
    // Persona first: the robot should know who it is before it is asked its
    // first question, not after.
    this.setPersona(personaPayload());
    // Ask once up front so the cliff readout is not blank on arrival.
    this.readSensor();
  }

  private teardown(): void {
    this.stopKeepalive();
    this.heldCommand = null;
    this.driving = false;
    try {
      this.transport.close();
    } catch {
      /* already closing */
    }
    this.link = null;
  }

  /** Feed raw bytes from the socket. */
  ingest(chunk: Uint8Array): void {
    const { packets, texts } = this.reader.feed(chunk);

    for (const text of texts) {
      const opName = text.op === 0x03 ? "reply" : text.op === 0x02 ? "speak" : "ask";
      this.handlers.onText?.(opName, text.text);
      if (text.op === 0x03) this.handlers.onReply?.(text.text);
    }

    for (const p of packets) this.onPacket(p);
  }

  /** The socket closed under us. */
  handleClose(reason = "connection closed"): void {
    this.log("warn", reason);
    this.stopKeepalive();
    this.heldCommand = null;
    this.driving = false;
    this.link = null;
    this.setStatus({ ...this.status, appHasControl: false });
    this.setState("disconnected");
    this.scheduleReconnect();
  }

  /** The socket reported an error without closing. */
  handleError(err: Error): void {
    this.log("error", `socket error: ${err.message}`);
    this.setState("error", { code: "E_INTERNAL", message: err.message });
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.opts.reconnect.enabled || !this.host) return;
    this.clearReconnect();
    const delay = Math.min(
      this.opts.reconnect.maxDelayMs,
      this.opts.reconnect.minDelayMs * 2 ** this.attempts,
    );
    this.attempts += 1;
    this.log("info", `reconnecting in ${delay}ms (attempt ${this.attempts})`);
    this.reconnectTimer = setTimeout(() => void this.open(), delay);
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

  private onPacket(p: DecodedPacket): void {
    if (p.type !== MSG_TYPE.STATUS) return;

    switch (p.cmd) {
      case ST.WELCOME:
      case ST.PONG:
      case ST.ROBOT_STATE:
        this.applyState(p.value);
        break;

      case ST.ACK:
        // An ack means the robot accepted the command, so any refusal it was
        // blocking on is over. Sensor blocks are exempt: a robot can ack a
        // non-motion command while still correctly refusing to drive, and
        // clearing the sensor block here would hide a real edge.
        if (this.blockCause === "link-timeout" || this.blockCause === "voice") {
          this.setBlocked(this.blockCause, null);
        }
        this.handlers.onAck?.(p.value);
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
        this.log("debug", `radio remote: ${remoteStateName(p.value)}`);
        break;

      case ST.BATTERY:
        // The current firmware never sends this, but if a battery is ever
        // fitted the app starts showing it with no further changes.
        this.setStatus(
          p.arg > 0
            ? { ...this.status, batteryMillivolts: p.arg }
            : { ...this.status, batteryMillivolts: undefined },
        );
        break;

      default:
        this.log("debug", `unhandled status 0x${p.cmd.toString(16)}`);
    }
  }

  private onRefusal(code: number): void {
    const message = errorMessage(code);
    this.handlers.onRefused?.(code, message);

    // LINK_TIMEOUT is the robot complaining about US, not refusing a command.
    // Re-arm the keepalive rather than tearing the connection down.
    if (code === ERR.LINK_TIMEOUT) {
      this.driving = false;
      this.heldCommand = null;
      this.setBlocked("link-timeout", message);
      this.log("warn", `${message} — resuming keepalive`);
      return;
    }

    // CLIFF and SENSOR_FAULT are a stop condition, not a retry condition.
    // Both clear as soon as the sensor reports safe again, handled in
    // applyCliff(); the cause is what links the two, not the wording.
    if (code === ERR.CLIFF || code === ERR.SENSOR_FAULT) {
      this.driving = false;
      this.heldCommand = null;
      this.setBlocked(code === ERR.CLIFF ? "cliff" : "sensor-fault", message);
      this.log("warn", message);
      return;
    }

    this.log("warn", message);
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
      this.setBlocked("voice", "Vulkan is thinking or speaking — wheels locked");
    } else {
      // A state change away from THINKING/SPEAKING lifts the voice block.
      this.clearBlocked("voice");
    }

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
        value === CLIFF.DROP ? "cliff" : "sensor-fault",
        value === CLIFF.DROP
          ? "Vulkan stopped: no floor ahead"
          : "Vulkan stopped: distance sensor is not responding",
      );
    } else {
      // A safe reading lifts either sensor block, whichever raised it. This
      // also clears a block set by an ERROR frame, so the UI cannot get stuck
      // showing a fault the robot has recovered from.
      this.clearBlocked("cliff");
      this.clearBlocked("sensor-fault");
    }
  }

  private setStatus(status: RobotStatus): void {
    this.status = status;
    this.handlers.onStatus?.({ ...status });
  }

  private setBlocked(cause: BlockCause, message: string | null): void {
    if (this.blockCause === cause && this.blockMessage === message) return;
    this.blockCause = cause;
    this.blockMessage = message;
    this.handlers.onBlocked?.(message);
  }

  /** Lift a block, but only if `cause` is the reason currently in force. */
  private clearBlocked(cause: BlockCause): void {
    if (this.blockCause !== cause) return;
    this.setBlocked(cause, null);
  }

  private setState(state: ConnectionState, error?: { code: string; message: string }): void {
    if (this.state === state && !error) return;
    this.state = state;
    this.handlers.onState?.(state, error);
  }

  private log(level: "debug" | "info" | "warn" | "error", message: string): void {
    this.handlers.onLog?.(level, message);
  }

  /* ------------------------------------------------------------ *
   * Outbound
   * ------------------------------------------------------------ */

  private nextSeq(): number {
    this.seq = (this.seq + 1) & 0xff;
    return this.seq;
  }

  private write(bytes: Uint8Array): boolean {
    if (!this.link || this.state !== "connected") return false;
    try {
      return this.transport.write(bytes);
    } catch (err) {
      this.log("error", `write failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private send(cmd: number, arg = 0, held = false, value = 0): boolean {
    return this.write(
      encodePacket(
        { type: MSG_TYPE.COMMAND, cmd, value, flags: held ? FLAG_HELD : 0, arg },
        this.nextSeq(),
      ),
    );
  }

  private sendText(op: number, text: string): boolean {
    return this.write(encodeTextFrame(op, text));
  }

  /**
   * Ask the robot to introduce itself. Sent on connect, which is what makes
   * the robot's state known before the operator touches anything.
   */
  hello(): boolean {
    this.log("debug", "hello");
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
   * Pressing arms the keepalive; releasing sends `stop` and disarms it. This is
   * the single most safety-critical call in the app, which is why the
   * operator's finger leaving the joystick is what stops the robot.
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
   * Commands
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

  /**
   * Tell the robot who it is.
   *
   * Sent on connect so the persona is in place before the first question. The
   * payload is truncated to the 240-byte text-frame limit, which the persona
   * is written to fit.
   */
  setPersona(json: string): boolean {
    if (!this.send(CMD.SET_PERSONA)) return false;
    return this.sendText(0x04, json.slice(0, TEXT_MAX));
  }
}