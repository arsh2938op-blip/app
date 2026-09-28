/**
 * The companion server: the single broker between the browser UI and the robot.
 *
 *   Browser UI  <--ws-->  Companion server  <--ws-->  ESP32-C3
 *
 * Why a server at all:
 *  - browsers cannot do mDNS discovery
 *  - the Gemini API key must never reach the browser or the ESP32
 *  - it gives one place to validate, rate-limit and log every message
 */

import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_ROBOT_PORT,
  SERVER_MSG,
  newRequestId,
  type ActivityEntry,
  type Command,
  type CommandEnvelope,
  type ConnectionState,
  type DiscoveredRobot,
  type EventEnvelope,
  type ServerMessage,
  type ServerStateMessage,
  type RobotStatus,
} from "../shared/protocol.js";
import { validateCommand } from "../shared/validateCommand.js";
import { RobotLink } from "./connection/robotLink.js";
import { RobotDiscovery } from "./discovery.js";
import { GeminiService, isServerHandled } from "./services/gemini.js";
import { SettingsStore, defaultSettingsFile, type StoredSettings } from "./storage/settingsStore.js";
import type { AppConfig } from "./config.js";

const ACTIVITY_LIMIT = 300;

export class AppServer {
  private readonly app = express();
  private readonly http: Server;
  private readonly appWss: WebSocketServer;
  private readonly link: RobotLink;
  private readonly gemini: GeminiService;
  private readonly settings: SettingsStore;
  private discovery: RobotDiscovery | null = null;
  private mock: import("../mock/mockRobot.js").MockRobot | null = null;

  private connection: ConnectionState = "disconnected";
  private lastError: ServerStateMessage["lastError"] = null;
  private source: "manual" | "mdns" | "demo" = "mdns";
  private activity: ActivityEntry[] = [];
  private demoMode = false;
  private readonly rate = { windowStart: 0, count: 0 };

  constructor(private readonly config: AppConfig) {
    this.settings = new SettingsStore(defaultSettingsFile());
    this.gemini = new GeminiService(config.geminiApiKey, config.geminiModel);
    this.link = new RobotLink({
      requestTimeoutMs: config.requestTimeoutMs,
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

    if (this.config.discovery.enabled) {
      this.discovery = new RobotDiscovery({
        onFound: (robot) => {
          this.log("info", `discovered ${robot.name} at ${robot.host}:${robot.port}`, "system");
          this.broadcast({ type: SERVER_MSG.ROBOTS, robots: this.discovery!.robots });
          // Auto-connect to the first robot seen, which is the common demo case.
          if (this.settings.get().connectionMethod === "mdns" && !this.demoMode) {
            void this.connectTo(robot.host, robot.port, "mdns");
          }
        },
        onLost: (id) => {
          this.log("warn", `robot ${id} disappeared`, "system");
          this.broadcast({
            type: SERVER_MSG.ROBOTS,
            robots: this.discovery?.robots ?? [],
          });
        },
        onError: (err) => this.log("warn", `mDNS unavailable: ${err.message}`, "system"),
      });
      this.discovery.start();
    }

    const stored = this.settings.get();
    if (this.config.demoMode) {
      await this.startDemoMode();
    } else if (this.config.lastKnownHost) {
      await this.connectTo(this.config.lastKnownHost, stored.port, "manual");
    }

    console.log(`WALL-E companion server on http://localhost:${this.config.port}`);
  }

  async stop(): Promise<void> {
    this.discovery?.stop();
    this.link.disconnect("server shutting down");
    for (const client of this.appWss.clients) client.close();
    this.appWss.close();
    await this.mock?.stop();
    await new Promise<void>((done) => this.http.close(() => done()));
  }

  /* ------------------------------------------------------------ *
   * Modes
   * ------------------------------------------------------------ */

  async startDemoMode(): Promise<void> {
    const { MockRobot } = await import("../mock/mockRobot.js");
    this.mock = new MockRobot({ port: 0, host: "127.0.0.1", name: this.settings.get().robotName });
    const port = await this.mock.start();
    this.demoMode = true;
    this.source = "demo";
    this.log("info", "DEMO MODE — simulated robot, no hardware involved", "system");
    this.settings.update({ demoMode: true });
    await this.connectTo("127.0.0.1", port, "demo");
  }

  async stopDemoMode(): Promise<void> {
    this.link.disconnect("leaving demo mode");
    await this.mock?.stop();
    this.mock = null;
    this.demoMode = false;
    this.source = "mdns";
    this.settings.update({ demoMode: false });
    this.log("info", "demo mode off", "system");
  }

  /* ------------------------------------------------------------ *
   * Connection
   * ------------------------------------------------------------ */

  async connectTo(host: string, port: number = DEFAULT_ROBOT_PORT, source: "manual" | "mdns" | "demo" = "manual") {
    const trimmed = host.trim();
    if (!trimmed) {
      this.setError("E_INVALID_PAYLOAD", "host is required");
      return;
    }
    this.source = source;
    this.lastError = null;
    this.log("info", `connecting to ${trimmed}:${port} (${source})`, "system");
    if (source !== "demo") {
      this.settings.update({ host: trimmed, port, connectionMethod: source });
    }
    this.link.connect(trimmed, port);
    this.pushState();
  }

  disconnect(): void {
    this.link.disconnect("disconnected by user");
    this.log("info", "disconnected by user", "system");
    this.pushState();
  }

  private wireLink(): void {
    this.link.on("state", (state, error) => {
      this.connection = state;
      if (error) this.lastError = { code: error.code, message: error.message };
      if (state === "disconnected") {
        this.log("warn", "WALL-E offline", "system");
      }
      this.pushState();
    });

    this.link.on("log", (level, message) => this.log(level, message, "system"));

    // The link owns the latest status snapshot; republish it so the UI's
    // state view and the status rows can never disagree.
    this.link.on("status", (status) => this.pushState());

    this.link.on("event", (event: EventEnvelope) => {
      this.broadcast({ type: SERVER_MSG.ACTIVITY, entry: this.fromEvent(event) });

      // Camera frames are routed to the camera view, not the activity feed,
      // so a 10 fps stream cannot flood the log.
      if (event.event === "camera_frame") {
        const p = event.payload as { mime: string; data: string };
        this.broadcast({
          type: SERVER_MSG.CAMERA,
          camera: { status: "snapshots" },
          frame: { mime: p.mime, data: p.data },
        });
      } else if (event.event === "camera_ready") {
        const p = event.payload as { streamUrl?: string };
        this.broadcast({
          type: SERVER_MSG.CAMERA,
          camera: { status: "live", streamUrl: p.streamUrl },
        });
      } else if (event.event === "camera_error") {
        const p = event.payload as { message?: string };
        this.broadcast({ type: SERVER_MSG.CAMERA, camera: { status: "error", error: p.message } });
      }
      // Mirror a robot reply into the chat transcript.
      if (event.event === "gemini_finished") {
        const text = (event.payload as { text: string }).text;
        this.broadcast({
          type: SERVER_MSG.ACTIVITY,
          entry: {
            id: newRequestId("act"),
            at: Date.now(),
            kind: "event",
            label: "WALL-E",
            detail: text,
            level: "info",
          },
        });
      }
      if (event.event === "stt_finished") {
        const transcript = (event.payload as { transcript: string }).transcript;
        if (transcript) {
          this.broadcast({
            type: SERVER_MSG.ACTIVITY,
            entry: {
              id: newRequestId("act"),
              at: Date.now(),
              kind: "event",
              label: "You (heard)",
              detail: transcript,
              level: "info",
            },
          });
        }
      }
    });

    this.link.on("response", (response) => {
      this.broadcast({
        type: SERVER_MSG.ACTIVITY,
        entry: {
          id: newRequestId("act"),
          at: Date.now(),
          kind: response.success ? "response" : "error",
          label: response.success ? "ack" : "nack",
          detail: response.success
            ? response.requestId
            : `${response.error?.code ?? "E_INTERNAL"}: ${response.error?.message ?? "unknown"}`,
          level: response.success ? "info" : "error",
          requestId: response.requestId,
        },
      });
      if (response.success && response.data && typeof response.data === "object") {
        const status = (response.data as { status?: RobotStatus }).status;
        if (status) this.pushStatus(status);
      }
    });
  }

  private pushStatus(status: RobotStatus): void {
    this.broadcast({
      type: SERVER_MSG.ACTIVITY,
      entry: {
        id: newRequestId("act"),
        at: Date.now(),
        kind: "event",
        label: "status",
        detail: `${status.state} / ${status.expression}`,
        level: "debug",
      },
    });
    // Status is part of the app state, so every update re-publishes it.
    this.pushState();
  }

  /* ------------------------------------------------------------ *
   * Command handling
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

  async handleCommand(raw: unknown): Promise<void> {
    const requestId =
      typeof raw === "object" && raw !== null && typeof (raw as { requestId?: unknown }).requestId === "string"
        ? (raw as { requestId: string }).requestId
        : newRequestId("req");

    if (this.rateLimited()) {
      this.log("warn", `rate limit hit; rejected ${requestId}`, "error");
      return;
    }

    const validated = validateCommand(raw);
    if (!validated.ok) {
      this.log("error", `rejected command: ${validated.message}`, "error", requestId);
      return;
    }
    const command: Command = validated.command;

    this.broadcast({
      type: SERVER_MSG.ACTIVITY,
      entry: {
        id: newRequestId("act"),
        at: Date.now(),
        kind: "command",
        label: command.command,
        level: "debug",
        requestId,
      },
    });

    // stop is sent without waiting for a reply: a blocked UI would be unsafe.
    if (command.command === "stop") {
      this.link.sendNowait(this.envelope(command, requestId));
      return;
    }

    if (isServerHandled(command)) {
      await this.handleServerSide(command, requestId);
      return;
    }

    // In demo mode the link is already connected to the in-process mock over a
    // real WebSocket, so the identical code path runs either way.
    await this.link.send(this.envelope(command, requestId));
  }

  private envelope(command: Command, requestId: string): CommandEnvelope {
    return {
      type: "command",
      v: 1,
      command: command.command,
      requestId,
      payload: command.payload,
      timestamp: Date.now(),
    };
  }

  private async handleServerSide(command: Command, requestId: string): Promise<void> {
    if (command.command === "ping") {
      this.log("info", "pong", "response", requestId);
      return;
    }
    if (command.command === "get_status") {
      const status = this.link.status;
      this.broadcast({
        type: SERVER_MSG.ACTIVITY,
        entry: {
          id: newRequestId("act"),
          at: Date.now(),
          kind: "response",
          label: "status",
          detail: status ? `${status.state} / ${status.expression}` : "no status yet",
          level: "debug",
          requestId,
        },
      });
      return;
    }
    if (command.command === "ask") {
      const { text } = command.payload as { text: string };
      try {
        const result = await this.gemini.ask(text, this.link.status ?? undefined);
        this.broadcast({
          type: SERVER_MSG.ACTIVITY,
          entry: {
            id: newRequestId("act"),
            at: Date.now(),
            kind: "event",
            label: "WALL-E",
            detail: result.text,
            level: "info",
            requestId,
          },
        });
        // Let the robot speak the answer, if it is reachable.
        const speak: Command = { command: "speak", payload: { text: result.text } };
        const envelope = this.envelope(speak, requestId);
        this.link.sendNowait(envelope);
      } catch (err) {
        this.log("error", `ask failed: ${(err as Error).message}`, "error", requestId);
      }
    }
  }

  /* ------------------------------------------------------------ *
   * HTTP + app WebSocket
   * ------------------------------------------------------------ */

  private registerRoutes(): void {
    this.app.use(express.json({ limit: "256kb" }));
    this.app.disable("x-powered-by");

    this.app.get("/api/health", (_req, res) => {
      res.json({ ok: true, connection: this.connection, demoMode: this.demoMode });
    });

    // The app WebSocket needs the per-boot token. Handing it over on the same
    // origin keeps the client bundle free of secrets, while still refusing
    // cross-origin WebSocket upgrades (browsers send Origin on WS handshakes).
    this.app.get("/api/session", (req, res) => {
      const origin = req.headers.origin;
      if (origin) {
        const host = req.headers.host;
        let allowed = false;
        try {
          const o = new URL(origin);
          allowed = o.host === host || o.hostname === "localhost";
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

    this.app.get("/api/state", (_req, res) => {
      res.json(this.stateMessage());
    });

    this.app.get("/api/settings", (_req, res) => {
      res.json({ ...this.settings.get(), geminiConfigured: this.gemini.available });
    });

    this.app.put("/api/settings", (req, res) => {
      const body = req.body as Partial<StoredSettings> & { geminiApiKey?: string };
      // An API key arriving here is stored in the environment only; it is never
      // echoed back and never forwarded to the robot.
      if (body.geminiApiKey) {
        process.env.GEMINI_API_KEY = body.geminiApiKey;
        this.log("info", "Gemini API key updated (server-side only)", "system");
      }
      const { geminiApiKey: _ignored, ...patch } = body;
      const next = this.settings.update(this.sanitizeSettings(patch));
      this.broadcast(this.stateMessage());
      res.json({ ...next, geminiConfigured: Boolean(process.env.GEMINI_API_KEY) });
    });

    this.app.post("/api/connect", async (req, res) => {
      const { host, port, method } = req.body as {
        host?: string;
        port?: number;
        method?: "mdns" | "manual";
      };
      if (method === "mdns") {
        const robots = await this.discover();
        const first = robots[0];
        if (!first) {
          res.status(404).json({ error: "no WALL-E found on this network" });
          return;
        }
        await this.connectTo(first.host, first.port, "mdns");
        res.json({ connected: true, robot: first });
        return;
      }
      if (!host) {
        res.status(400).json({ error: "host is required" });
        return;
      }
      await this.connectTo(host, Number(port) || DEFAULT_ROBOT_PORT, "manual");
      res.json({ connected: true });
    });

    this.app.post("/api/disconnect", (_req, res) => {
      this.disconnect();
      res.json({ ok: true });
    });

    this.app.get("/api/discover", async (_req, res) => {
      res.json({ robots: await this.discover() });
    });

    this.app.post("/api/demo", async (req, res) => {
      const on = Boolean((req.body as { enabled?: unknown }).enabled);
      if (on && !this.demoMode) await this.startDemoMode();
      if (!on && this.demoMode) await this.stopDemoMode();
      res.json({ demoMode: this.demoMode });
    });

    this.app.get("/api/activity", (_req, res) => {
      res.json({ entries: this.activity });
    });

    this.app.get("/api/config", (_req, res) => {
      res.json({
        port: this.config.port,
        geminiConfigured: this.gemini.available,
        geminiModel: this.config.geminiModel,
        discoveryEnabled: this.config.discovery.enabled,
        rateLimit: this.config.rateLimit,
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
    if (typeof patch.host === "string" || patch.host === null) out.host = patch.host;
    if (Number.isFinite(patch.port)) out.port = Number(patch.port);
    if (patch.connectionMethod) out.connectionMethod = patch.connectionMethod;
    if (typeof patch.autoReconnect === "boolean") out.autoReconnect = patch.autoReconnect;
    if (Number.isFinite(patch.motorSpeed)) {
      out.motorSpeed = Math.max(0, Math.min(1, Number(patch.motorSpeed)));
    }
    if (Number.isFinite(patch.volume)) out.volume = Math.max(0, Math.min(1, Number(patch.volume)));
    if (typeof patch.demoMode === "boolean") out.demoMode = patch.demoMode;
    if (typeof patch.cameraEnabled === "boolean") out.cameraEnabled = patch.cameraEnabled;
    return out as Partial<StoredSettings>;
  }

  private wireHttp(): void {
    this.http.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname !== "/ws") {
        socket.destroy();
        return;
      }
      // Token check. In dev, Vite proxies the browser here, so the token is
      // supplied by the client bundle via query param.
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
      ws.send(JSON.stringify(this.stateMessage()));
      ws.send(JSON.stringify({ type: SERVER_MSG.ROBOTS, robots: this.discovery?.robots ?? [] }));
      ws.send(
        JSON.stringify({
          type: SERVER_MSG.ACTIVITY,
          entry: {
            id: newRequestId("act"),
            at: Date.now(),
            kind: "system",
            label: this.demoMode ? "demo mode active" : "app connected",
            level: "info",
          },
        }),
      );

      ws.on("message", (data) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          this.log("warn", "dropped malformed client frame", "error");
          return;
        }
        if (typeof parsed !== "object" || parsed === null) return;
        const msg = parsed as { type?: string; command?: unknown };
        if (msg.type === "command") {
          void this.handleCommand(parsed);
        }
      });
    });
  }

  /* ------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------ */

  private async discover(timeoutMs = this.config.discovery.timeoutMs): Promise<DiscoveredRobot[]> {
    if (!this.discovery) {
      this.log("warn", "discovery is disabled; use manual IP entry", "system");
      return [];
    }
    this.log("info", "scanning for WALL-E on the local network", "system");
    return this.discovery.browse(timeoutMs);
  }

  private fromEvent(event: EventEnvelope): ActivityEntry {
    const payload = event.payload as Record<string, unknown>;
    let detail: string | undefined;
    let level: ActivityEntry["level"] = "info";

    if (event.event === "error") {
      level = "error";
      detail = `${payload.code}: ${payload.message}`;
    } else if (event.event === "log") {
      level = (payload.level as ActivityEntry["level"]) ?? "info";
      detail = String(payload.message ?? "");
    } else if (event.event === "state_changed") {
      detail = String(payload.state ?? "");
    } else if (event.event === "expression_changed") {
      detail = String(payload.expression ?? "");
    } else if (event.event === "movement_started") {
      detail = String(payload.direction ?? "");
    } else if (event.event === "status" || event.event === "robot_ready") {
      detail = undefined;
    } else {
      const keys = ["text", "transcript", "direction", "reason", "enabled"];
      const found = keys.map((k) => payload[k]).find((v) => typeof v === "string");
      detail = typeof found === "string" ? found : undefined;
    }

    return {
      id: newRequestId("act"),
      at: event.timestamp,
      kind: event.event === "error" ? "error" : "event",
      label: event.event,
      detail,
      level,
      requestId: event.requestId,
    };
  }

  private log(
    level: "debug" | "info" | "warn" | "error",
    label: string,
    kind: ActivityEntry["kind"] = "system",
    requestId?: string,
    detail?: string,
  ): void {
    const entry: ActivityEntry = {
      id: newRequestId("act"),
      at: Date.now(),
      kind,
      label,
      detail,
      level,
      requestId,
    };
    this.activity.push(entry);
    if (this.activity.length > ACTIVITY_LIMIT) this.activity.shift();
    if (level === "error" || level === "warn") {
      this.lastError = { code: level === "error" ? "E_INTERNAL" : "E_BUSY", message: `${label}${detail ? `: ${detail}` : ""}` };
    }
    this.broadcast({ type: SERVER_MSG.ACTIVITY, entry });
    this.pushState();
  }

  private setError(code: string, message: string): void {
    this.lastError = { code, message };
    this.log("error", message, "error");
  }

  private stateMessage(): ServerStateMessage {
    const target = this.link.target;
    return {
      type: SERVER_MSG.STATE,
      connection: this.connection,
      demoMode: this.demoMode,
      robotName: this.settings.get().robotName,
      target:
        this.source === "demo"
          ? { host: "demo", port: 0, source: "demo" }
          : target
            ? { ...target, source: this.source }
            : null,
      status: this.link.status,
      lastError: this.lastError,
    };
  }

  private pushState(): void {
    this.broadcast(this.stateMessage());
  }

  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const client of this.appWss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }

  get activityLog(): readonly ActivityEntry[] {
    return this.activity;
  }

  get linkRef(): RobotLink {
    return this.link;
  }

  get settingsRef(): SettingsStore {
    return this.settings;
  }

  get isDemoMode(): boolean {
    return this.demoMode;
  }
}

export function createAppServer(config: AppConfig): AppServer {
  return new AppServer(config);
}
