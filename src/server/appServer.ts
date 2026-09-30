/**
 * The companion server: the single broker between the app UI and the robot.
 *
 *   Android app / browser UI  <--ws-->  Companion server  <--TCP-->  ESP32-S3
 *
 * Why a server sits in the middle:
 *  - the browser cannot open a raw TCP socket, and the robot speaks a
 *    binary protocol over TCP
 *  - one place to hold the 700 ms safety watchdog
 *  - one place to validate everything before it reaches a robot
 *
 * The robot firmware has no mDNS, so the app cannot discover it. The robot's
 * IP comes from its serial log, is typed once, and is then remembered.
 */

import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";

import {
  DEFAULT_ROBOT_PORT,
  MAX_STEPS,
  clampArg,
  commandName,
} from "../shared/walleProtocol.js";
import {
  SERVER_MSG,
  type ActivityEntry,
  type AppCommand,
  type ConnectionState,
  type ServerMessage,
  type ServerStateMessage,
} from "../shared/walleTypes.js";
import { validateAppCommand } from "../shared/validateAppCommand.js";
import { RobotLink } from "./connection/robotLink.js";
import { SettingsStore, defaultSettingsFile, type StoredSettings } from "./storage/settingsStore.js";
import type { AppConfig } from "./config.js";

const ACTIVITY_LIMIT = 300;

export class AppServer {
  private readonly app = express();
  private readonly http: Server;
  private readonly appWss: WebSocketServer;
  private readonly link: RobotLink;
  private readonly settings: SettingsStore;

  private connection: ConnectionState = "disconnected";
  private lastError: ServerStateMessage["lastError"] = null;
  private activity: ActivityEntry[] = [];
  private demoMode = false;
  private mock: import("../mock/mockRobot.js").MockRobot | null = null;
  private sensorTimer: NodeJS.Timeout | null = null;
  private actCounter = 0;

  private readonly rate = { windowStart: 0, count: 0 };

  constructor(private readonly config: AppConfig) {
    this.settings = new SettingsStore(defaultSettingsFile());
    this.link = new RobotLink({
      reconnect: config.reconnect,
      token: config.robotToken,
    });
    this.appWss = new WebSocketServer({ noServer: true });
    this.http = createServer(this.app);
    this.wireHttp();
    this.wireLink();
    this.wireAppSockets();
    this.registerRoutes();
  }

  /* ------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------ */

  async start(): Promise<void> {
    await new Promise<void>((done) => this.http.listen(this.config.port, this.config.host, done));

    const stored = this.settings.get();
    if (this.config.demoMode) {
      await this.startDemoMode();
    } else if (this.config.defaultRobotHost) {
      await this.connectTo(this.config.defaultRobotHost, stored.port);
    }

    this.log("info", `listening on http://localhost:${this.config.port}`, "system");
  }

  async stop(): Promise<void> {
    this.stopSensorPolling();
    this.link.disconnect("server shutting down");
    for (const client of this.appWss.clients) client.close();
    this.appWss.close();
    await this.mock?.stop();
    await new Promise<void>((done) => this.http.close(() => done()));
  }

  /* ------------------------------------------------------------ *
   * Demo mode
   * ------------------------------------------------------------ */

  async startDemoMode(): Promise<void> {
    const { MockRobot } = await import("../mock/mockRobot.js");
    this.stopSensorPolling();
    this.mock = new MockRobot({ port: 0, host: "127.0.0.1" });
    const port = await this.mock.start();
    this.demoMode = true;
    this.log("info", "DEMO MODE — simulated robot, no hardware involved", "system");
    this.settings.update({ demoMode: true });
    await this.connectTo("127.0.0.1", port);
  }

  async stopDemoMode(): Promise<void> {
    this.link.disconnect("leaving demo mode");
    await this.mock?.stop();
    this.mock = null;
    this.demoMode = false;
    this.settings.update({ demoMode: false });
    this.log("info", "demo mode off", "system");
  }

  /* ------------------------------------------------------------ *
   * Connection
   * ------------------------------------------------------------ */

  async connectTo(host: string, port: number = DEFAULT_ROBOT_PORT): Promise<void> {
    const trimmed = host.trim();
    if (!trimmed) {
      this.log("error", "an IP address is required", "error");
      return;
    }
    this.lastError = null;
    this.log("info", `connecting to ${trimmed}:${port}`, "system");
    if (!this.demoMode) this.settings.update({ host: trimmed, port });
    this.link.connect(trimmed, port);
    this.pushState();
  }

  disconnect(): void {
    this.stopSensorPolling();
    this.link.disconnect("disconnected by user");
    this.pushState();
  }

  private wireLink(): void {
    this.link.on("state", (state, error) => {
      this.connection = state;
      if (error) this.lastError = { code: error.code, message: error.message };
      if (state === "connected") {
        this.startSensorPolling();
        this.link.startIdleKeepalive();
      } else {
        this.stopSensorPolling();
        if (state === "disconnected") this.log("warn", "WALL-E offline", "system");
      }
      this.pushState();
    });

    this.link.on("log", (level, message) => this.log(level, message, "system"));

    this.link.on("status", () => this.pushState());

    this.link.on("ack", (commandId) => {
      this.log("debug", `ack ${commandName(commandId)}`, "response");
    });

    this.link.on("reply", (text) => {
      // WALL-E's answer, straight from the robot's own Gemini call.
      this.log("info", "WALL-E", "event", undefined, text);
    });

    this.link.on("text", (op, text) => {
      if (op !== "reply") this.log("debug", `${op}: ${text}`, "event");
    });

    this.link.on("refused", (code, message) => {
      this.log("error", message, "error");
    });

    // A block is a persistent condition, not a one-off refusal, so republish
    // the state whenever it changes. Without this the operator would see the
    // reason only whenever some unrelated status frame happened to arrive.
    this.link.on("blocked", () => this.pushState());
  }

  /* ------------------------------------------------------------ *
   * Cliff sensor polling
   * ------------------------------------------------------------ */

  private startSensorPolling(): void {
    this.stopSensorPolling();
    const period = this.settings.get().sensorPollMs;
    if (period <= 0) return;
    // Each poll is a real ultrasonic echo on the robot, so the rate is
    // capped deliberately rather than being as fast as the socket allows.
    this.sensorTimer = setInterval(() => this.link.readSensor(), period);
  }

  private stopSensorPolling(): void {
    if (this.sensorTimer) {
      clearInterval(this.sensorTimer);
      this.sensorTimer = null;
    }
  }

  /* ------------------------------------------------------------ *
   * Command routing
   * ------------------------------------------------------------ */

  private rateLimited(): boolean {
    const { windowMs, maxCommands } = this.config.rateLimit;
    const now = Date.now();
    if (now - this.rate.windowStart > windowMs) {
      this.rate.windowStart = now;
      this.rate.count = 0;
    }
    this.rate.count += 1;
    return this.rate.count > maxCommands;
  }

  /**
   * Handle one command from the app.
   *
   * Accepts either a bare command object or a full envelope with a `command`
   * field, so a caller does not have to know which shape the UI happens to
   * send. Everything is validated after unwrapping.
   */
  handleAppCommand(input: unknown): void {
    if (this.rateLimited()) {
      this.log("warn", "rate limit reached", "error");
      return;
    }

    const raw = unwrapCommand(input);
    if (raw === null) {
      this.log("error", "rejected: command name is required", "error");
      return;
    }

    const validated = validateAppCommand(raw);
    if (!validated.ok) {
      this.log("error", `rejected: ${validated.message}`, "error");
      return;
    }

    const cmd = validated.command;
    this.log("debug", describeAppCommand(cmd), "command");

    if (!this.requireConnection()) return;

    switch (cmd.name) {
      case "hello":
        this.link.hello();
        return;

      case "ping":
        this.link.ping();
        return;

      case "bye":
        this.link.bye();
        return;

      case "drive":
        this.link.drive(cmd.command, cmd.held);
        this.pushState();
        return;

      case "stop":
        this.link.stop();
        this.pushState();
        return;

      case "simple":
        this.link.simple(cmd.command);
        return;

      case "move_steps":
        this.link.moveSteps(cmd.steps);
        return;

      case "turn_degrees":
        this.link.turnDegrees(cmd.degrees);
        return;

      case "turn_around":
        this.link.turnAround();
        return;

      case "read_sensor":
        this.link.readSensor();
        return;

      case "autonomous":
        this.link.setAutonomous(cmd.enabled);
        return;

      case "expression":
        this.link.setExpression(cmd.command);
        return;

      case "ask":
        this.link.ask(cmd.text);
        return;

      case "speak":
        this.link.speak(cmd.text);
        return;
    }
  }

  private requireConnection(): boolean {
    if (this.connection === "connected") return true;
    this.log("warn", "not connected to WALL-E", "error");
    return false;
  }

  /* ------------------------------------------------------------ *
   * HTTP
   * ------------------------------------------------------------ */

  private registerRoutes(): void {
    this.app.use(express.json({ limit: "64kb" }));
    this.app.disable("x-powered-by");

    this.app.get("/api/health", (_req, res) => {
      res.json({ ok: true, connection: this.connection, demoMode: this.demoMode });
    });

    /**
     * The app WebSocket needs the per-boot token. Handing it over on the
     * same origin keeps the client bundle free of secrets while still
     * refusing cross-origin WebSocket upgrades.
     */
    this.app.get("/api/session", (req, res) => {
      const origin = req.headers.origin;
      if (origin) {
        const host = req.headers.host;
        let allowed = false;
        try {
          allowed = new URL(origin).host === host;
        } catch {
          allowed = false;
        }
        if (!allowed) {
          res.status(403).json({ error: "cross-origin session request" });
          return;
        }
      }
      res.json({ token: this.config.appToken });
    });

    this.app.get("/api/state", (_req, res) => res.json(this.stateMessage()));

    this.app.get("/api/settings", (_req, res) => res.json(this.settings.get()));

    this.app.put("/api/settings", (req, res) => {
      const next = this.settings.update(this.sanitizeSettings(req.body as Partial<StoredSettings>));
      // Poll-rate changes take effect immediately.
      if (this.connection === "connected") this.startSensorPolling();
      this.pushState();
      res.json(next);
    });

    this.app.post("/api/connect", async (req, res) => {
      const { host, port } = req.body as { host?: string; port?: number };
      if (!host || !host.trim()) {
        res.status(400).json({ error: "the robot's IP address is required" });
        return;
      }
      await this.connectTo(host, Number(port) || DEFAULT_ROBOT_PORT);
      res.json({ ok: true });
    });

    this.app.post("/api/disconnect", (_req, res) => {
      this.disconnect();
      res.json({ ok: true });
    });

    this.app.post("/api/demo", async (req, res) => {
      const on = Boolean((req.body as { enabled?: unknown }).enabled);
      if (on && !this.demoMode) await this.startDemoMode();
      if (!on && this.demoMode) await this.stopDemoMode();
      res.json({ demoMode: this.demoMode });
    });

    this.app.get("/api/activity", (_req, res) => res.json({ entries: this.activity }));

    // A tiny manual scan. The robot does not advertise itself, so this only
    // helps when you already know roughly where on the subnet it is.
    this.app.get("/api/scan", (_req, res) => {
      res.json({
        note: "WALL-E does not advertise over mDNS; enter the IP from its serial log",
        configuredHost: this.settings.get().host,
      });
    });

    // Serve the built client in production; in dev, Vite serves it instead.
    const here = fileURLToPath(new URL(".", import.meta.url));
    const clientDir = resolve(here, "../../dist/client");
    if (existsSync(clientDir)) {
      this.app.use(express.static(clientDir));
      this.app.get("*", (_req, res) => res.sendFile(resolve(clientDir, "index.html")));
    }
  }

  private sanitizeSettings(patch: Partial<StoredSettings>): Partial<StoredSettings> {
    const out: Record<string, unknown> = {};
    if (typeof patch.robotName === "string" && patch.robotName.trim()) {
      out.robotName = patch.robotName.trim().slice(0, 32);
    }
    if (typeof patch.host === "string") out.host = patch.host.trim() || null;
    if (patch.host === null) out.host = null;
    if (Number.isFinite(patch.port)) {
      out.port = Math.max(1, Math.min(65535, Number(patch.port)));
    }
    if (typeof patch.autoReconnect === "boolean") out.autoReconnect = patch.autoReconnect;
    if (Number.isFinite(patch.stepCount)) {
      out.stepCount = clampArg(Number(patch.stepCount), 1, MAX_STEPS);
    }
    if (Number.isFinite(patch.sensorPollMs)) {
      // 0 disables polling; otherwise 100..2000 ms.
      const v = Number(patch.sensorPollMs);
      out.sensorPollMs = v === 0 ? 0 : clampArg(v, 100, 2000);
    }
    if (typeof patch.demoMode === "boolean") out.demoMode = patch.demoMode;
    return out as Partial<StoredSettings>;
  }

  private wireHttp(): void {
    this.http.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname !== "/ws") {
        socket.destroy();
        return;
      }
      const token = url.searchParams.get("token") ?? req.headers["x-walle-token"];
      if (token !== this.config.appToken) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.appWss.handleUpgrade(req, socket, head, (ws) => {
        this.appWss.emit("connection", ws, req);
      });
    });
  }

  private wireAppSockets(): void {
    this.appWss.on("connection", (ws: WebSocket) => {
      this.send(ws, this.stateMessage());

      ws.on("message", (data) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          this.log("warn", "dropped malformed app frame", "error");
          return;
        }
        this.handleAppCommand(parsed);
      });
    });
  }

  /* ------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------ */

  private log(
    level: "debug" | "info" | "warn" | "error",
    label: string,
    kind: ActivityEntry["kind"] = "system",
    seq?: number,
    detail?: string,
  ): void {
    const entry: ActivityEntry = {
      id: `a${++this.actCounter}`,
      at: Date.now(),
      kind,
      label,
      detail,
      level,
      seq,
    };
    this.activity.push(entry);
    if (this.activity.length > ACTIVITY_LIMIT) this.activity.shift();

    if (level === "error" || level === "warn") {
      this.lastError = { code: level === "error" ? "E_REFUSED" : "E_WARN", message: detail ? `${label} — ${detail}` : label };
    }
    this.sendAll({ type: SERVER_MSG.ACTIVITY, entry });
    this.pushState();
  }

  private stateMessage(): ServerStateMessage {
    return {
      type: SERVER_MSG.STATE,
      connection: this.connection,
      demoMode: this.demoMode,
      robotName: this.settings.get().robotName,
      target: this.link.target,
      status: this.link.robotStatus,
      lastError: this.lastError,
      driving: this.link.isDriving,
      blocked: this.link.blocked,
    };
  }

  private pushState(): void {
    this.sendAll(this.stateMessage());
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private sendAll(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const client of this.appWss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }

  /* Accessors used by tests. */
  get linkRef(): RobotLink {
    return this.link;
  }

  get settingsRef(): SettingsStore {
    return this.settings;
  }

  get mockRef(): import("../mock/mockRobot.js").MockRobot | null {
    return this.mock;
  }

  get isDemoMode(): boolean {
    return this.demoMode;
  }
}

/**
 * Pull the command object out of a frame.
 *
 * Returns null for anything that is not an object, or that carries no
 * recognisable command name, so the validator produces one clear error
 * rather than a different one per malformed shape.
 */
function unwrapCommand(input: unknown): Record<string, unknown> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.name === "string") return obj;
  // An envelope: { type: "command", command: { name: ... } }
  if (typeof obj.command === "object" && obj.command !== null && !Array.isArray(obj.command)) {
    return obj.command as Record<string, unknown>;
  }
  return obj;
}

/** Short human label for the activity feed. */
function describeAppCommand(cmd: AppCommand): string {
  switch (cmd.name) {
    case "drive":
      return `${commandName(cmd.command)}${cmd.held ? " (held)" : ""}`;
    case "simple":
      return commandName(cmd.command);
    case "expression":
      return commandName(cmd.command);
    case "move_steps":
      return `move ${cmd.steps} steps`;
    case "turn_degrees":
      return `turn ${cmd.degrees}°`;
    case "turn_around":
      return "turn around";
    case "read_sensor":
      return "read sensor";
    case "autonomous":
      return `autonomous ${cmd.enabled ? "on" : "off"}`;
    case "ask":
      return `ask: ${cmd.text.slice(0, 40)}`;
    case "speak":
      return `speak: ${cmd.text.slice(0, 40)}`;
    default:
      return cmd.name;
  }
}

export function createAppServer(config: AppConfig): AppServer {
  return new AppServer(config);
}
