/**
 * App-side types: the JSON layer between the browser UI and the companion
 * server, plus the normalised robot state derived from binary status frames.
 *
 * The browser never sees the binary protocol. That is deliberate — a browser
 * cannot open a raw TCP socket, so the companion server does the framing and
 * the UI consumes ordinary JSON.
 */

import type { CliffState, ErrorId, RobotStateName } from "./walleProtocol.js";

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

/** Everything the UI needs to draw the robot, assembled from status frames. */
export interface RobotStatus {
  /** Mirrors the firmware's RobotState as a lowercase name. */
  state: RobotStateName;
  stateCode: number;
  /** Who currently owns the wheels, as the firmware reports it. */
  remoteState: "disconnected" | "connecting" | "connected" | "timeout";
  /** True when this app holds the control lock. */
  appHasControl: boolean;
  /** True when the handheld radio remote holds it. */
  remoteHasControl: boolean;
  /** The robot is driving itself, not being commanded. */
  autonomous: boolean;
  cliff: CliffState;
  cliffName: string;
  /** Vertical distance from the sensor to the floor, in cm. */
  groundCm: number;
  /** Only present if the robot ever reports a real battery reading. */
  batteryMillivolts?: number;
  /** True while the robot has deliberately blocked its wheels to talk. */
  wheelsBlocked: boolean;
}

export const EMPTY_STATUS: RobotStatus = {
  state: "boot",
  stateCode: 0,
  remoteState: "disconnected",
  appHasControl: false,
  remoteHasControl: false,
  autonomous: false,
  cliff: 0,
  cliffName: "unknown",
  groundCm: 0,
  wheelsBlocked: false,
};

export interface ChatMessage {
  id: string;
  from: "user" | "robot" | "system";
  text: string;
  at: number;
}

export type ActivityLevel = "debug" | "info" | "warn" | "error";

export type ActivityKind = "event" | "command" | "response" | "error" | "system";

export interface ActivityEntry {
  id: string;
  at: number;
  kind: ActivityKind;
  label: string;
  detail?: string;
  level?: ActivityLevel;
  /** Correlates a command with its response, on the server path. */
  requestId?: string;
}

/* ------------------------------------------------------------------ *
 * Server -> browser
 * ------------------------------------------------------------------ */

export const SERVER_MSG = {
  STATE: "server_state",
  ACTIVITY: "activity",
} as const;

export interface ServerStateMessage {
  type: typeof SERVER_MSG.STATE;
  connection: ConnectionState;
  demoMode: boolean;
  robotName: string;
  target: { host: string; port: number } | null;
  status: RobotStatus | null;
  lastError: { code: string; message: string } | null;
  /** True while the app is actively driving, so the UI can show a state. */
  driving: boolean;
  /** Set when the robot refuses commands because it is talking. */
  blocked: string | null;
}

export interface ActivityMessage {
  type: typeof SERVER_MSG.ACTIVITY;
  entry: ActivityEntry;
}

export type ServerMessage = ServerStateMessage | ActivityMessage;

/* ------------------------------------------------------------------ *
 * Browser -> server
 * ------------------------------------------------------------------ */

export type AppCommand =
  | { name: "hello" }
  | { name: "ping" }
  | { name: "bye" }
  /** Held direction. `held: true` sets the HELD flag and arms the keepalive. */
  | { name: "drive"; command: number; held: boolean }
  | { name: "stop" }
  | { name: "simple"; command: number }
  | { name: "move_steps"; steps: number }
  | { name: "turn_degrees"; degrees: number }
  | { name: "turn_around" }
  | { name: "read_sensor" }
  | { name: "ask"; text: string }
  | { name: "speak"; text: string }
  | { name: "autonomous"; enabled: boolean }
  | { name: "expression"; command: number };

export interface AppCommandEnvelope {
  type: "command";
  v: 1;
  command: AppCommand;
  /** Correlates activity entries; not part of the robot wire protocol. */
  requestId: string;
  timestamp: number;
}

export type { ErrorId };
