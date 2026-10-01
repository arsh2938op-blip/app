/**
 * The on-device robot link.
 *
 * Wraps `RobotCore` — the same protocol code the desktop server runs — over
 * the Android TCP plugin. This is what removes the laptop from the picture:
 * the phone opens the socket, frames the packets, keeps the 700 ms watchdog
 * fed and reconnects, with no companion server involved.
 */

import {
  RobotCore,
  type BlockCause,
  type RobotCoreHandlers,
  type RobotCoreOptions,
} from "../shared/robotCore.js";
import { NativeTcpTransport } from "./nativeLink.js";
import type { ConnectionState, RobotStatus } from "../shared/walleTypes.js";

export interface DirectRobotHandlers {
  onState: (state: ConnectionState, target: { host: string; port: number } | null) => void;
  onStatus: (status: RobotStatus) => void;
  onBlocked: (reason: string | null) => void;
  /** The robot's spoken answer, as a text frame. */
  onReply: (text: string) => void;
  onRefused: (code: number, message: string) => void;
  onAck: (commandId: number) => void;
  onLog: (level: "debug" | "info" | "warn" | "error", message: string) => void;
}

const DEFAULTS: RobotCoreOptions = {
  reconnect: { enabled: true, minDelayMs: 500, maxDelayMs: 10_000 },
};

export class DirectRobot {
  readonly core: RobotCore;

  private readonly transport: NativeTcpTransport;

  constructor(handlers: DirectRobotHandlers, opts?: Partial<RobotCoreOptions>) {
    this.transport = new NativeTcpTransport();

    // The socket pushes bytes in, the core hands frames back out.
    this.transport.onData = (chunk) => this.core.ingest(chunk);
    this.transport.onClose = (reason) => this.core.handleClose(reason);

    const bridge: RobotCoreHandlers = {
      onState: (state) => handlers.onState(state, this.core.target),
      onStatus: (status) => handlers.onStatus(status),
      onBlocked: (reason) => handlers.onBlocked(reason),
      onReply: (text) => handlers.onReply(text),
      onRefused: (code, message) => handlers.onRefused(code, message),
      onAck: (command) => handlers.onAck(command),
      onLog: (level, message) => handlers.onLog(level, message),
      onText: () => {},
    };

    this.core = new RobotCore(
      this.transport,
      {
        reconnect: opts?.reconnect ?? DEFAULTS.reconnect,
        keepalive: opts?.keepalive,
      },
      bridge,
    );
  }

  connect(host: string, port?: number): void {
    this.core.connect(host, port);
  }

  disconnect(reason?: string): void {
    this.core.disconnect(reason);
  }

  get state(): ConnectionState {
    return this.core.connectionState;
  }

  get blocked(): string | null {
    return this.core.blocked;
  }
}

export type { BlockCause };