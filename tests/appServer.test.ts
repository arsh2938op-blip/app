import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import WebSocket from "ws";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServer } from "../src/server/appServer.js";
import { createAppServer } from "../src/server/appServer.js";
import { loadConfig, type AppConfig } from "../src/server/config.js";
import { SettingsStore, DEFAULT_SETTINGS } from "../src/server/storage/settingsStore.js";
import { CMD, CLIFF } from "../src/shared/walleProtocol.js";
import { SERVER_MSG, type ServerMessage } from "../src/shared/walleTypes.js";

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig(),
    port: 0,
    host: "127.0.0.1",
    appToken: "test-token",
    defaultRobotHost: null,
    demoMode: false,
    rateLimit: { windowMs: 1000, maxCommands: 500 },
    ...overrides,
  };
}

interface Client {
  ws: WebSocket;
  msgs: ServerMessage[];
  send: (name: string, extra?: Record<string, unknown>) => void;
  close: () => void;
}

async function openClient(port: number, token = "test-token"): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  const msgs: ServerMessage[] = [];
  ws.on("message", (raw) => {
    try {
      msgs.push(JSON.parse(raw.toString()) as ServerMessage);
    } catch {
      /* ignore */
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  let n = 0;
  return {
    ws,
    msgs,
    send: (name, extra = {}) =>
      ws.send(
        JSON.stringify({
          type: "command",
          v: 1,
          command: { name, ...extra },
          requestId: `t${++n}`,
          timestamp: Date.now(),
        }),
      ),
    close: () => ws.close(),
  };
}

async function until<T>(fn: () => T | undefined | false, timeoutMs = 5000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  return undefined;
}

const lastState = (c: Client) => {
  const s = [...c.msgs].reverse().find((m) => m.type === SERVER_MSG.STATE);
  return s?.type === SERVER_MSG.STATE ? s : undefined;
};

const hasActivity = (c: Client, label: string | RegExp) =>
  c.msgs.some(
    (m) =>
      m.type === SERVER_MSG.ACTIVITY &&
      (typeof label === "string" ? m.entry.label === label : label.test(m.entry.label)),
  );

describe("AppServer in demo mode", () => {
  let server: AppServer;
  let port: number;
  let tmp: string;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "walle-test-"));
    server = createAppServer(testConfig());
    (server as unknown as { settings: SettingsStore }).settings = new SettingsStore(
      join(tmp, "settings.json"),
    );
    await server.start();
    await server.startDemoMode();
    port = (server as unknown as { http: { address(): { port: number } } }).http.address().port;
  });

  afterAll(async () => {
    await server.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  const connected = async (): Promise<Client> => {
    const c = await openClient(port);
    await until(() => lastState(c)?.connection === "connected", 8000);
    return c;
  };

  /**
   * Tests share one server and one simulator, so anything that changes the
   * robot's physical situation is reset here. Without this a test that leaves
   * WALL-E at a table edge makes the next one fail depending on order.
   */
  beforeEach(() => {
    server.mockRef?.setCliff(CLIFF.GROUND, 12);
  });

  /**
   * Polling is disabled for the cliff tests.
   *
   * A read_sensor issued just before the test injects a fault can still be in
   * flight, and its reply carries the reading from *before* the fault. That
   * stale SENSOR frame then clears the block the test is waiting for, and the
   * test fails depending on where the poller happened to be. Silencing the
   * poller leaves only traffic the test caused, so the assertions mean what
   * they say.
   *
   * The change goes through the HTTP settings route rather than writing the
   * store directly, because that route is what restarts the poll timer.
   */
  const withoutPolling = async (fn: () => Promise<void>) => {
    const setPoll = (ms: number) =>
      fetch(`http://127.0.0.1:${port}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sensorPollMs: ms }),
      }).then((r) => r.json() as Promise<{ sensorPollMs: number }>);

    const original = server.settingsRef.get().sensorPollMs;
    await setPoll(0);
    try {
      await fn();
    } finally {
      await setPoll(original);
    }
  };

  it("rejects an app socket with the wrong token", async () => {
    await expect(openClient(port, "nope")).rejects.toBeTruthy();
  });

  it("reaches connected state against the simulated robot", async () => {
    const c = await connected();
    const s = lastState(c);
    expect(s?.connection).toBe("connected");
    expect(s?.demoMode).toBe(true);
    expect(s?.target?.port).toBeGreaterThan(0);
    c.close();
  });

  it("has already learned the robot state by the time a client connects", async () => {
    // The link sends HELLO on connect, so the state is known before any UI
    // attaches and the status panel is populated on first paint.
    const c = await connected();
    const s = lastState(c);
    expect(s?.status).not.toBeNull();
    expect(s?.status?.stateCode).toBeGreaterThan(0);
    c.close();
  });

  it("drives forward while held and stops on release", async () => {
    const c = await connected();
    c.send("drive", { command: CMD.MOVE_FORWARD, held: true });
    expect(await until(() => hasActivity(c, "move_forward (held)"), 3000)).toBe(true);
    expect(await until(() => lastState(c)?.driving === true, 3000)).toBe(true);

    c.send("stop", {});
    expect(await until(() => hasActivity(c, "stop"), 3000)).toBe(true);
    c.close();
  });

  it("sends an immediate stop command", async () => {
    const c = await connected();
    c.send("stop");
    expect(await until(() => hasActivity(c, "stop"), 3000)).toBe(true);
    c.close();
  });

  it("runs a timed step move", async () => {
    const c = await connected();
    c.send("move_steps", { steps: 4 });
    expect(await until(() => hasActivity(c, "move 4 steps"), 3000)).toBe(true);
    c.close();
  });

  it("turns by degrees and turns around", async () => {
    const c = await connected();
    c.send("turn_degrees", { degrees: 90 });
    expect(await until(() => hasActivity(c, "turn 90°"), 3000)).toBe(true);
    c.send("turn_around", {});
    expect(await until(() => hasActivity(c, "turn around"), 3000)).toBe(true);
    c.close();
  });

  it("changes expression", async () => {
    const c = await connected();
    c.send("expression", { command: CMD.EXPR_HAPPY });
    expect(await until(() => hasActivity(c, "expression_happy"), 3000)).toBe(true);
    c.close();
  });

  it("dances", async () => {
    const c = await connected();
    c.send("simple", { command: CMD.DANCE });
    expect(await until(() => lastState(c)?.status?.state === "dancing", 4000)).toBe(true);
    expect(await until(() => lastState(c)?.status?.state === "idle", 8000)).toBe(true);
    c.close();
  });

  it("toggles autonomous mode", async () => {
    const c = await connected();
    c.send("autonomous", { enabled: true });
    expect(await until(() => lastState(c)?.status?.autonomous === true, 4000)).toBe(true);
    c.send("autonomous", { enabled: false });
    expect(await until(() => lastState(c)?.status?.autonomous === false, 4000)).toBe(true);
    c.close();
  });

  it("sends an ask and shows the reply in the activity feed", async () => {
    const c = await connected();
    c.send("ask", { text: "Tell me a joke." });
    const reply = await until(
      () =>
        c.msgs.find(
          (m) => m.type === SERVER_MSG.ACTIVITY && m.entry.label === "WALL-E" && m.entry.detail,
        ),
      6000,
    );
    expect(reply).toBeDefined();
    if (reply?.type !== SERVER_MSG.ACTIVITY) return;
    expect(reply.entry.detail).toMatch(/cross the road|Beep boop/i);
    c.close();
  });

  it("sends a verbatim speak command", async () => {
    const c = await connected();
    c.send("speak", { text: "battery low" });
    const reply = await until(
      () =>
        c.msgs.find(
          (m) =>
            m.type === SERVER_MSG.ACTIVITY && m.entry.label === "WALL-E" && m.entry.detail === "battery low",
        ),
      6000,
    );
    expect(reply).toBeDefined();
    c.close();
  });

  it("reads the cliff sensor and reports ground distance", async () => {
    const c = await connected();
    c.send("read_sensor", {});
    expect(await until(() => (lastState(c)?.status?.groundCm ?? 0) > 0, 4000)).toBe(true);
    expect(lastState(c)?.status?.cliffName).toBe("ground");
    c.close();
  });

  it("surfaces a cliff refusal and blocks movement", async () => {
    await withoutPolling(async () => {
      const c = await connected();
      server.mockRef!.setCliff(CLIFF.DROP, 44);
      // Wording comes from the firmware's own error table.
      expect(await until(() => (lastState(c)?.blocked ?? "").match(/edge/i), 5000)).toBeDefined();
      c.send("drive", { command: CMD.MOVE_FORWARD, held: true });
      expect(await until(() => hasActivity(c, /stopped at the edge/), 4000)).toBe(true);
      // The block must clear on its own once the floor is back, otherwise the
      // UI would keep refusing to drive after the robot is safe again.
      server.mockRef!.setCliff(CLIFF.GROUND, 12);
      expect(await until(() => lastState(c)?.blocked === null, 5000)).toBeDefined();
      c.close();
    });
  });

  it("republishes state when a block clears, not only when one appears", async () => {
    // A stale "blocked" banner that never clears is worse than no banner:
    // the operator would think WALL-E is broken.
    await withoutPolling(async () => {
      const c = await connected();
      server.mockRef!.setCliff(CLIFF.FAULT, 0);
      expect(await until(() => /sensor/i.test(lastState(c)?.blocked ?? ""), 5000)).toBeDefined();

      // Remember where the client is in the stream, then clear the fault and
      // require a frame arriving AFTER that point to carry the clear. This
      // asserts the republish itself rather than a message count, which would
      // otherwise depend on how often a sensor poll happened to fire.
      const mark = c.msgs.length;
      server.mockRef!.setCliff(CLIFF.GROUND, 12);

      const cleared = await until(
        () => c.msgs.slice(mark).some((m) => m.type === SERVER_MSG.STATE && m.blocked === null),
        5000,
      );
      expect(cleared).toBeDefined();
      c.close();
    });
  });

  it("rejects an unknown command", async () => {
    const c = await openClient(port);
    c.send("self_destruct", {});
    expect(
      await until(
        () =>
          c.msgs.some(
            (m) => m.type === SERVER_MSG.ACTIVITY && /rejected/.test(m.entry.label ?? ""),
          ),
        3000,
      ),
    ).toBe(true);
    c.close();
  });

  it("rejects a direction that is not a direction", async () => {
    const c = await openClient(port);
    c.send("drive", { command: CMD.DANCE, held: true });
    expect(
      await until(
        () =>
          c.msgs.some(
            (m) => m.type === SERVER_MSG.ACTIVITY && /rejected/.test(m.entry.label ?? ""),
          ),
        3000,
      ),
    ).toBe(true);
    c.close();
  });

  it("clamps an out-of-range step count rather than erroring", async () => {
    const c = await connected();
    c.send("move_steps", { steps: 9999 });
    expect(await until(() => hasActivity(c, "move 50 steps"), 3000)).toBe(true);
    c.close();
  });

  it("ignores a malformed app frame instead of crashing", async () => {
    const c = await connected();
    expect(() => c.ws.send("{{{ not json")).not.toThrow();
    await new Promise((r) => setTimeout(r, 200));
    c.send("ping", {});
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.close();
  });

  it("reconnects after the robot goes away", async () => {
    const c = await connected();
    await server.stopDemoMode();
    expect(await until(() => lastState(c)?.connection === "disconnected", 5000)).toBeDefined();

    await server.startDemoMode();
    expect(await until(() => lastState(c)?.connection === "connected", 10000)).toBeDefined();
    c.close();
  });
});

describe("AppServer HTTP surface", () => {
  let server: AppServer;
  let base: string;
  let tmp: string;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "walle-http-"));
    server = createAppServer(testConfig());
    (server as unknown as { settings: SettingsStore }).settings = new SettingsStore(
      join(tmp, "settings.json"),
    );
    await server.start();
    const p = (server as unknown as { http: { address(): { port: number } } }).http.address().port;
    base = `http://127.0.0.1:${p}`;
  });

  afterAll(async () => {
    await server.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reports health", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("issues an app socket token to a same-origin request", async () => {
    const res = await fetch(`${base}/api/session`, { headers: { origin: base } });
    expect(res.status).toBe(200);
    expect((await res.json()).token).toBe("test-token");
  });

  it("refuses a cross-origin session request", async () => {
    const res = await fetch(`${base}/api/session`, { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("accepts a WebSocket upgrade carrying the issued token", async () => {
    const { token } = (await (await fetch(`${base}/api/session`)).json()) as { token: string };
    const c = await openClient(Number(new URL(base).port), token);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.close();
  });

  it("returns settings and exposes no secrets", async () => {
    const body = (await (await fetch(`${base}/api/settings`)).json()) as Record<string, unknown>;
    expect(body.robotName).toBe("WALL-E");
    expect(Object.keys(body).join(",")).not.toMatch(/key|secret|token/i);
  });

  it("saves settings and clamps them", async () => {
    const res = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stepCount: 9999, sensorPollMs: 5, robotName: "  WALLE  " }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.stepCount).toBe(50);
    expect(body.sensorPollMs).toBe(100);
    expect(body.robotName).toBe("WALLE");
  });

  it("allows disabling sensor polling", async () => {
    const res = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sensorPollMs: 0 }),
    });
    expect(((await res.json()) as { sensorPollMs: number }).sensorPollMs).toBe(0);
  });

  it("rejects a connect request with no host", async () => {
    const res = await fetch(`${base}/api/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("explains that the robot does not advertise itself", async () => {
    const body = (await (await fetch(`${base}/api/scan`)).json()) as { note: string };
    expect(body.note).toMatch(/serial log/i);
  });

  it("exposes activity history", async () => {
    const body = (await (await fetch(`${base}/api/activity`)).json()) as { entries: unknown[] };
    expect(Array.isArray(body.entries)).toBe(true);
  });
});

describe("SettingsStore", () => {
  it("returns defaults when the file is missing", () => {
    const store = new SettingsStore(join(mkdtempSync(join(tmpdir(), "walle-s-")), "none.json"));
    expect(store.get()).toMatchObject(DEFAULT_SETTINGS);
  });

  it("round-trips an update through disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "walle-s-"));
    const file = join(dir, "settings.json");
    new SettingsStore(file).update({ robotName: "WALL-E", stepCount: 9 });
    expect(new SettingsStore(file).get().stepCount).toBe(9);
  });

  it("survives a corrupt file", () => {
    const dir = mkdtempSync(join(tmpdir(), "walle-s-"));
    const file = join(dir, "settings.json");
    writeFileSync(file, "{{{ not json", "utf8");
    expect(() => new SettingsStore(file).get()).not.toThrow();
  });
});
