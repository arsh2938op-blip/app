/**
 * TCP link to the ESP32-S3 robot, for the companion server.
 *
 * All this does is own a `net.Socket` and hand bytes to `RobotCore`. The
 * protocol, the 700 ms watchdog, reconnect backoff and every safety rule live
 * in `src/shared/robotCore.ts`, which the on-device app also uses — so the
 * two can never disagree about what a command means.
 */

import { EventEmitter } from "node:events";
import net from "node:net";
import { RobotCore, type ByteTransport, type RobotCoreHandlers } from "../../shared/robotCore.js";
import type { ConnectionState, RobotStatus } from "../../shared/walleTypes.js";

export interface RobotLinkOptions {
  reconnect: { enabled: boolean; minDelayMs: number; maxDelayMs: number };
  /** Optional bearer secret, if the robot ever requires one. */
  token?: string;
  keepalive?: { heldMs: number; pingMs: number };
  /** Injected in tests. */
  createSocket?: (host: string, port: number) => net.Socket;
}

export interface RobotLinkEvents {
  state: (state: ConnectionState, error?: { code: string; message: string }) => void;
  status: (status: RobotStatus) => void;
  log: (level: "debug" | "info" | "warn" | "error", message: string) => void;
  /** The robot's spoken answer, from a TEXT reply frame. */
  reply: (text: string) => void;
  /** The robot refused a command. `code` is a firmware ErrorId. */
  refused: (code: number, message: string) => void;
  /**
   * Why the robot will not move right now, or null when it can.
   *
   * Distinct from `refused`: a refusal is a response to a command, this is a
   * persistent condition the operator needs to see until it clears.
   */
  blocked: (reason: string | null) => void;
  ack: (commandId: number) => void;
  text: (op: string, text: string) => void;
}

export declare interface RobotLink {
  on<K extends keyof RobotLinkEvents>(event: K, listener: RobotLinkEvents[K]): this;
  emit<K extends keyof RobotLinkEvents>(event: K, ...args: Parameters<RobotLinkEvents[K]>): boolean;
}

/** A `net.Socket` behind the transport interface RobotCore expects. */
class NodeSocketTransport implements ByteTransport {
  private socket: net.Socket | null = null;

  constructor(
    private readonly core: () => RobotCore,
    private readonly create: (host: string, port: number) => net.Socket,
  ) {}

  open(host: string, port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let socket: net.Socket;
      try {
        socket = this.create(host, port);
      } catch (err) {
        reject(err as Error);
        return;
      }
      this.socket = socket;
      socket.setNoDelay(true); // frames are 10 bytes; Nagle only adds latency

      // A socket with no 'error' listener that is later destroyed takes the
      // whole process down. This no-op is the standard guard.
      socket.on("error", () => {});

      const onConnect = () => {
        socket.off("error", onError);
        socket.off("close", onClose);
        resolve();
      };
      const onError = (err: Error) => {
        socket.off("connect", onConnect);
        socket.off("close", onClose);
        reject(err);
      };
      const onClose = () => {
        socket.off("connect", onConnect);
        socket.off("error", onError);
        // The peer hung up before the handshake finished.
        reject(new Error("connection closed during handshake"));
      };

      socket.once("connect", onConnect);
      socket.once("error", onError);
      socket.once("close", onClose);

      socket.on("data", (chunk: Buffer) => {
        this.core().ingest(new Uint8Array(chunk));
      });
      socket.on("close", () => this.core().handleClose());
      socket.on("error", (err: Error) => this.core().handleError(err));
    });
  }

  write(bytes: Uint8Array): boolean {
    if (!this.socket) return false;
    try {
      return this.socket.write(Buffer.from(bytes));
    } catch {
      return false;
    }
  }

  close(): void {
    const s = this.socket;
    this.socket = null;
    if (!s) return;
    try {
      // Detach first so our own handlers do not schedule a second teardown.
      s.removeAllListeners();
      s.destroy();
    } catch {
      /* already closing */
    }
  }
}

export class RobotLink extends EventEmitter {
  private readonly core: RobotCore;
  private readonly transport: NodeSocketTransport;

  constructor(opts: RobotLinkOptions) {
    super();
    this.setMaxListeners(50);

    const create =
      opts.createSocket ??
      ((h: string, p: number) => {
        const s = new net.Socket();
        // The constructor form does not connect; open() below starts the
        // handshake. Using the 2-arg form would open the socket twice.
        s.connect(p, h);
        return s;
      });

    let self: RobotCore | null = null;
    this.transport = new NodeSocketTransport(() => self!, create);

    const handlers: RobotCoreHandlers = {
      onState: (state, error) => this.emit("state", state, error),
      onStatus: (status) => this.emit("status", status),
      onLog: (level, message) => this.emit("log", level, message),
      onReply: (text) => this.emit("reply", text),
      onRefused: (code, message) => this.emit("refused", code, message),
      onBlocked: (reason) => this.emit("blocked", reason),
      onAck: (command) => this.emit("ack", command),
      onText: (op, text) => this.emit("text", op, text),
    };

    self = new RobotCore(
      this.transport,
      { reconnect: opts.reconnect, keepalive: opts.keepalive },
      handlers,
    );
    this.core = self;
  }

  get connectionState(): ConnectionState {
    return this.core.connectionState;
  }

  get robotStatus(): RobotStatus {
    return this.core.robotStatus;
  }

  get target(): { host: string; port: number } | null {
    return this.core.target;
  }

  get isDriving(): boolean {
    return this.core.isDriving;
  }

  get blocked(): string | null {
    return this.core.blocked;
  }

  connect(host: string, port?: number): void {
    this.core.connect(host, port);
  }

  disconnect(reason?: string): void {
    this.core.disconnect(reason);
  }

  /** Tests drive the socket directly through this. */
  ingest(chunk: Uint8Array): void {
    this.core.ingest(chunk);
  }

  hello(): boolean {
    return this.core.hello();
  }

  ping(): boolean {
    return this.core.ping();
  }

  bye(): boolean {
    return this.core.bye();
  }

  drive(command: number, held: boolean): boolean {
    return this.core.drive(command, held);
  }

  stop(): boolean {
    return this.core.stop();
  }

  startIdleKeepalive(): void {
    this.core.startIdleKeepalive();
  }

  simple(command: number): boolean {
    return this.core.simple(command);
  }

  moveSteps(steps: number): boolean {
    return this.core.moveSteps(steps);
  }

  turnDegrees(degrees: number): boolean {
    return this.core.turnDegrees(degrees);
  }

  turnAround(): boolean {
    return this.core.turnAround();
  }

  readSensor(): boolean {
    return this.core.readSensor();
  }

  setAutonomous(enabled: boolean): boolean {
    return this.core.setAutonomous(enabled);
  }

  setExpression(command: number): boolean {
    return this.core.setExpression(command);
  }

  ask(text: string): boolean {
    return this.core.ask(text);
  }

  speak(text: string): boolean {
    return this.core.speak(text);
  }
}