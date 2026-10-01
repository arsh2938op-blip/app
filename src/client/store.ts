/**
 * App-side state, socket and REST helpers.
 *
 * The UI never sees the binary protocol. It sends JSON commands over a
 * WebSocket to the companion server, which frames them for the robot.
 */

import { useSyncExternalStore } from "react";
import {
  CMD,
  DEFAULT_ROBOT_PORT,
  commandName,
  type CommandId,
  type RobotStateName,
} from "../shared/walleProtocol.js";
import { withSignature } from "../shared/persona.js";
import { DirectRobot } from "./directRobot.js";
import { isNativeLinkAvailable } from "./nativeLink.js";
import {
  EMPTY_STATUS,
  SERVER_MSG,
  type ActivityEntry,
  type AppCommand,
  type ChatMessage,
  type ConnectionState,
  type RobotStatus,
  type ServerMessage,
  type ServerStateMessage,
} from "../shared/walleTypes.js";

export interface AppStore {
  /** True when the browser is talking to the companion server. */
  socketConnected: boolean;
  connection: ConnectionState;
  demoMode: boolean;
  robotName: string;
  target: ServerStateMessage["target"];
  status: RobotStatus | null;
  lastError: { code: string; message: string } | null;
  activity: ActivityEntry[];
  chat: ChatMessage[];
  driving: boolean;
  /** Set when the robot refuses movement, e.g. it is speaking. */
  blocked: string | null;
  settings: AppSettings | null;
}

const ACTIVITY_LIMIT = 200;
const CHAT_LIMIT = 60;

let state: AppStore = {
  socketConnected: false,
  connection: "disconnected",
  demoMode: false,
  robotName: "WALL-E",
  target: null,
  status: { ...EMPTY_STATUS },
  lastError: null,
  activity: [],
  chat: [],
  driving: false,
  blocked: null,
  settings: null,
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function setState(patch: Partial<AppStore>): void {
  state = { ...state, ...patch };
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useStore<T>(selector: (s: AppStore) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

export function getState(): AppStore {
  return state;
}

/* ------------------------------------------------------------------ *
 * Socket
 * ------------------------------------------------------------------ */

let socket: WebSocket | null = null;
let reconnectTimer: number | undefined;
let tokenPromise: Promise<string> | null = null;
let msgCounter = 0;

/**
 * The app socket is authenticated with a per-boot token, fetched from the
 * companion server on its own origin so nothing secret ships in the bundle.
 */
function appToken(): Promise<string> {
  tokenPromise ??= fetch("/api/session")
    .then((r) => (r.ok ? r.json() : { token: "" }))
    .then((b: { token?: string }) => b.token ?? "")
    .catch(() => "");
  return tokenPromise;
}

export function connectAppSocket(): () => void {
  if (socket && socket.readyState <= WebSocket.OPEN) return () => {};

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const base = `${proto}://${location.host}/ws`;

  void appToken().then((token) => {
    const ws = new WebSocket(token ? `${base}?token=${encodeURIComponent(token)}` : base);
    socket = ws;

    ws.onopen = () => setState({ socketConnected: true });
    ws.onclose = () => {
      setState({ socketConnected: false, connection: "disconnected", driving: false });
      window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(connectAppSocket, 1500);
    };
    ws.onerror = () => {
      /* onclose follows and drives the retry */
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data as string) as ServerMessage;
      } catch {
        return; // ignore junk
      }
      applyMessage(msg);
    };
  });

  return () => {
    window.clearTimeout(reconnectTimer);
    socket?.close();
    socket = null;
  };
}

function applyMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case SERVER_MSG.STATE:
      setState({
        connection: msg.connection,
        demoMode: msg.demoMode,
        robotName: msg.robotName,
        target: msg.target,
        status: msg.status ?? state.status,
        lastError: msg.connection === "connected" ? null : msg.lastError,
        driving: msg.driving,
        blocked: msg.blocked,
      });
      break;

    case SERVER_MSG.ACTIVITY: {
      const entry = msg.entry;
      const activity = [entry, ...state.activity].slice(0, ACTIVITY_LIMIT);
      let chat = state.chat;

      // The user typed something.
      if (entry.kind === "command" && (entry.label.startsWith("ask:") || entry.label.startsWith("speak:"))) {
        const text = entry.label.slice(entry.label.indexOf(":") + 1).trim();
        chat = [...chat, { id: entry.id, from: "user" as const, text, at: entry.at }].slice(
          -CHAT_LIMIT,
        );
      }
      // WALL-E spoke.
      if (entry.kind === "event" && entry.label === "WALL-E" && entry.detail) {
        chat = [...chat, { id: entry.id, from: "robot" as const, text: entry.detail, at: entry.at }].slice(
          -CHAT_LIMIT,
        );
      }
      setState({ activity, chat });
      break;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

export function sendAppCommand(command: AppCommand): void {
  const id = `ui-${Date.now().toString(36)}-${++msgCounter}`;

  // On the phone, commands go straight to the robot over its own TCP socket.
  // No companion server, no laptop, nothing else to start.
  if (direct) {
    sendDirect(command);
    logLocal(describeCommand(command), undefined, "command", id);
    return;
  }

  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "command", v: 1, command, requestId: id, timestamp: Date.now() }));
}

/* ------------------------------------------------------------------ *
 * Direct link: the phone speaks TCP to the robot itself
 * ------------------------------------------------------------------ */

let direct: DirectRobot | null = null;

/**
 * Start talking to the robot directly.
 *
 * No-op anywhere there is no raw TCP plugin, which is how a desktop browser
 * ends up on the companion server instead. Returns whether the direct path is
 * now in use, so the UI can say which one it is.
 */
export function startDirectLink(): boolean {
  if (direct) return true;
  if (!isNativeLinkAvailable()) return false;
  try {
    direct = new DirectRobot({
      onState: (connection, target) =>
        setState({ connection, target, lastError: null, demoMode: false }),
      onStatus: (status) => setState({ status, driving: status.appHasControl }),
      onBlocked: (blocked) => setState({ blocked }),
      onReply: (text) =>
        // The transcript shows the signature even if the firmware forgot it.
        // The activity feed keeps the raw text, so a genuine bug stays visible.
        logLocal("WALL-E", withSignature(text), "event"),
      onRefused: (_code, message) => logLocal("refused", message, "error"),
      onLog: (level, message) => logLocal(level, message, "event"),
      onAck: (cmd) => logLocal("ack", commandName(cmd), "response"),
    });
    return true;
  } catch {
    direct = null;
    return false;
  }
}

export function isDirectLink(): boolean {
  return direct !== null;
}

/** Point the direct link at a robot. */
export function connectDirect(host: string, port = DEFAULT_ROBOT_PORT): void {
  if (!direct) return;
  direct.connect(host, port);
}

export function disconnectDirect(): void {
  direct?.disconnect("disconnected by user");
}

function sendDirect(command: AppCommand): void {
  if (!direct) return;
  switch (command.name) {
    case "hello": return void direct.core.hello();
    case "ping": return void direct.core.ping();
    case "bye": return void direct.core.bye();
    case "drive": return void direct.core.drive(command.command, command.held);
    case "stop": return void direct.core.stop();
    case "simple": return void direct.core.simple(command.command);
    case "move_steps": return void direct.core.moveSteps(command.steps);
    case "turn_degrees": return void direct.core.turnDegrees(command.degrees);
    case "turn_around": return void direct.core.turnAround();
    case "read_sensor": return void direct.core.readSensor();
    case "autonomous": return void direct.core.setAutonomous(command.enabled);
    case "expression": return void direct.core.setExpression(command.command);
    case "ask": return void direct.core.ask(command.text);
    case "speak": return void direct.core.speak(command.text);
  }
}

/** Short label for the activity feed, matching the server's wording. */
function describeCommand(command: AppCommand): string {
  switch (command.name) {
    case "drive": return `${commandName(command.command)}${command.held ? " (held)" : ""}`;
    case "simple":
    case "expression": return commandName(command.command);
    case "move_steps": return `move ${command.steps} steps`;
    case "turn_degrees": return `turn ${command.degrees}°`;
    case "turn_around": return "turn around";
    case "read_sensor": return "read sensor";
    case "autonomous": return `autonomous ${command.enabled ? "on" : "off"}`;
    case "ask": return `ask: ${command.text.slice(0, 40)}`;
    case "speak": return `speak: ${command.text.slice(0, 40)}`;
    default: return command.name;
  }
}

let localCounter = 0;

/** Push an entry into the activity feed from the direct path. */
function logLocal(
  label: string,
  detail: string | undefined,
  kind: "event" | "command" | "response" | "error",
  requestId = `d${++localCounter}`,
): void {
  const entry: ActivityEntry = {
    id: `${requestId}-${++localCounter}`,
    at: Date.now(),
    kind,
    label,
    detail,
    level: kind === "error" ? "error" : kind === "command" ? "debug" : "info",
    requestId,
  };

  let chat = state.chat;
  if (kind === "command" && label.startsWith("ask:")) {
    chat = [...chat, { id: entry.id, from: "user" as const, text: detail ?? "", at: entry.at }].slice(
      -CHAT_LIMIT,
    );
  } else if (kind === "event" && label === "WALL-E" && detail) {
    chat = [...chat, { id: entry.id, from: "robot" as const, text: detail, at: entry.at }].slice(
      -CHAT_LIMIT,
    );
  }
  setState({ activity: [entry, ...state.activity].slice(0, ACTIVITY_LIMIT), chat });
}

/* ---- movement ---- */

/** Press a direction. Starts the robot's 700 ms watchdog being fed. */
export function driveStart(command: CommandId): void {
  sendAppCommand({ name: "drive", command, held: true });
}

/**
 * Release a direction. This is what actually stops the robot, so it is the
 * one call that must never be skipped. The server also disarms its keepalive.
 */
export function driveEnd(): void {
  sendAppCommand({ name: "stop" });
}

export function emergencyStop(): void {
  sendAppCommand({ name: "stop" });
}

/* ---- timed motions ---- */

export function moveSteps(steps: number): void {
  sendAppCommand({ name: "move_steps", steps });
}

export function turnDegrees(degrees: number): void {
  sendAppCommand({ name: "turn_degrees", degrees });
}

export function turnAround(): void {
  sendAppCommand({ name: "turn_around" });
}

export function readSensor(): void {
  sendAppCommand({ name: "read_sensor" });
}

/* ---- modes and expressions ---- */

export function dance(): void {
  sendAppCommand({ name: "simple", command: CMD.DANCE });
}

export function explore(): void {
  sendAppCommand({ name: "simple", command: CMD.EXPLORE });
}

export function setIdle(): void {
  sendAppCommand({ name: "simple", command: CMD.IDLE });
}

export function setAutonomous(enabled: boolean): void {
  sendAppCommand({ name: "autonomous", enabled });
}

export function setExpression(command: CommandId): void {
  sendAppCommand({ name: "expression", command });
}

/* ---- voice ---- */

export function ask(text: string): void {
  sendAppCommand({ name: "ask", text });
}

export function speak(text: string): void {
  sendAppCommand({ name: "speak", text });
}

export function talk(): void {
  sendAppCommand({ name: "simple", command: CMD.TALK });
}

export function joke(): void {
  sendAppCommand({ name: "simple", command: CMD.JOKE });
}

/* ------------------------------------------------------------------ *
 * REST
 * ------------------------------------------------------------------ */

export interface AppSettings {
  robotName: string;
  host: string | null;
  port: number;
  autoReconnect: boolean;
  stepCount: number;
  sensorPollMs: number;
  demoMode: boolean;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const api = {
  state: () => req<ServerStateMessage>("/api/state"),
  settings: () => req<AppSettings>("/api/settings"),
  saveSettings: (patch: Partial<AppSettings>) =>
    req<AppSettings>("/api/settings", { method: "PUT", body: JSON.stringify(patch) }),
  connect: (host: string, port: number) =>
    req<{ ok: boolean }>("/api/connect", {
      method: "POST",
      body: JSON.stringify({ host, port }),
    }),
  disconnect: () => req<{ ok: boolean }>("/api/disconnect", { method: "POST" }),
  demo: (enabled: boolean) =>
    req<{ demoMode: boolean }>("/api/demo", { method: "POST", body: JSON.stringify({ enabled }) }),
  activity: () => req<{ entries: ActivityEntry[] }>("/api/activity"),
  scan: () => req<{ note: string; configuredHost: string | null }>("/api/scan"),
};

export function loadSettings(): Promise<void> {
  return api
    .settings()
    .then((s) => setState({ settings: s }))
    .catch(() => {});
}

export type { RobotStatus, RobotStateName, ActivityEntry, ChatMessage, ConnectionState };
