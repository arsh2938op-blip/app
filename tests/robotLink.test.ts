import { describe, expect, it, beforeEach, afterEach } from "vitest";
import net from "node:net";
import { MockRobot } from "../src/mock/mockRobot.js";
import { RobotLink } from "../src/server/connection/robotLink.js";
import {
  APP_TIMEOUT_MS,
  CLIFF,
  CMD,
  ERR,
  MSG_TYPE,
  ROBOT_STATE,
  ST,
  encodePacket,
  type DecodedPacket,
} from "../src/shared/walleProtocol.js";

async function until<T>(fn: () => T | undefined | false, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  return undefined;
}

function makeLink(port: number, extra: Record<string, unknown> = {}): RobotLink {
  const link = new RobotLink({
    reconnect: { enabled: false, minDelayMs: 20, maxDelayMs: 40 },
    ...extra,
  });
  link.connect("127.0.0.1", port);
  return link;
}

describe("RobotLink against the mock robot", () => {
  let robot: MockRobot;
  let port: number;
  let link: RobotLink;
  const seen: DecodedPacket[] = [];

  beforeEach(async () => {
    seen.length = 0;
    robot = new MockRobot({ port: 0, host: "127.0.0.1", onPacket: (p) => seen.push(p) });
    port = await robot.start();
  });

  afterEach(async () => {
    // Stop the robot and clear any simulated edge before the next test, so
    // ordering cannot leak a WALL-E that is refusing to move.
    link?.disconnect("test cleanup");
    link = undefined as unknown as RobotLink;
    robot.setCliff(CLIFF.GROUND, 12);
    await robot.stop();
  });

  async function connected(): Promise<RobotLink> {
    link = makeLink(port);
    await until(() => link.connectionState === "connected", 3000);
    return link;
  }

  it("connects and receives a WELCOME", async () => {
    const l = await connected();
    await until(() => l.robotStatus.stateCode !== 0 || l.robotStatus.state === "idle", 2000);
    expect(l.connectionState).toBe("connected");
    expect(l.robotStatus.state).toBe("idle");
  });

  it("sends HELLO on connect", async () => {
    await connected();
    await until(() => seen.some((p) => p.cmd === CMD.HELLO), 1500);
    expect(seen.some((p) => p.cmd === CMD.HELLO)).toBe(true);
  });

  it("drives forward when held and stops on release", async () => {
    const l = await connected();
    l.drive(CMD.MOVE_FORWARD, true);
    await until(() => robot.isDriving, 1500);
    expect(robot.isDriving).toBe(true);
    expect(l.isDriving).toBe(true);

    l.drive(CMD.STOP, false);
    await until(() => !robot.isDriving, 1500);
    expect(robot.isDriving).toBe(false);
  });

  it("sets the HELD flag on a held direction", async () => {
    const l = await connected();
    l.drive(CMD.MOVE_FORWARD, true);
    await until(() => seen.some((p) => p.cmd === CMD.MOVE_FORWARD), 1500);
    const held = seen.filter((p) => p.cmd === CMD.MOVE_FORWARD).pop();
    expect((held?.flags ?? 0) & 0x01).toBe(0x01);
    l.drive(CMD.STOP, false);
  });

  it("keeps the robot fed while held, past the watchdog", async () => {
    const l = await connected();
    l.drive(CMD.MOVE_FORWARD, true);
    // The keepalive must outlast APP_TIMEOUT_MS without operator input.
    await new Promise((r) => setTimeout(r, APP_TIMEOUT_MS + 400));
    expect(robot.isDriving).toBe(true);
    l.drive(CMD.STOP, false);
  });

  it("re-sends the held command on the keepalive interval", async () => {
    await connected();
    link.drive(CMD.MOVE_FORWARD, true);
    await until(() => seen.filter((p) => p.cmd === CMD.MOVE_FORWARD).length >= 3, 2000);
    expect(seen.filter((p) => p.cmd === CMD.MOVE_FORWARD).length).toBeGreaterThanOrEqual(3);
    link.drive(CMD.STOP, false);
  });

  it("stops sending when released", async () => {
    const l = await connected();
    l.drive(CMD.MOVE_FORWARD, true);
    await until(() => seen.filter((p) => p.cmd === CMD.MOVE_FORWARD).length >= 2, 1500);
    l.drive(CMD.STOP, false);
    const after = seen.filter((p) => p.cmd === CMD.MOVE_FORWARD).length;
    await new Promise((r) => setTimeout(r, 700));
    expect(seen.filter((p) => p.cmd === CMD.MOVE_FORWARD).length).toBe(after);
  });

  it("sends STOP with no HELD flag", async () => {
    const l = await connected();
    l.drive(CMD.MOVE_FORWARD, true);
    await until(() => seen.some((p) => p.cmd === CMD.MOVE_FORWARD), 1500);
    l.drive(CMD.STOP, false);
    await until(() => seen.some((p) => p.cmd === CMD.STOP), 1000);
    const stop = seen.find((p) => p.cmd === CMD.STOP);
    expect((stop?.flags ?? 1) & 0x01).toBe(0);
  });

  it("drives the robot into the REMOTE state while held", async () => {
    const l = await connected();
    l.drive(CMD.TURN_LEFT, true);
    await until(() => l.robotStatus.stateCode === ROBOT_STATE.REMOTE, 2000);
    expect(l.robotStatus.stateCode).toBe(ROBOT_STATE.REMOTE);
    expect(l.robotStatus.appHasControl).toBe(true);
    l.drive(CMD.STOP, false);
  });

  it("runs a timed move_steps with the step count in arg", async () => {
    await connected();
    link.moveSteps(4);
    await until(() => seen.some((p) => p.cmd === CMD.MOVE_STEPS), 1500);
    const p = seen.find((x) => x.cmd === CMD.MOVE_STEPS)!;
    expect(p.arg).toBe(4);
    await until(() => link.robotStatus.stateCode === ROBOT_STATE.IDLE, 3000);
  });

  it("turns a given number of degrees", async () => {
    await connected();
    link.turnDegrees(90);
    await until(() => seen.some((p) => p.cmd === CMD.TURN_DEGREES), 1500);
    expect(seen.find((p) => p.cmd === CMD.TURN_DEGREES)!.arg).toBe(90);
  });

  it("asks a question and receives a text reply frame", async () => {
    const replies: string[] = [];
    link = makeLink(port);
    link.on("reply", (t) => replies.push(t));
    await until(() => link.connectionState === "connected", 3000);

    link.ask("Tell me a joke.");
    await until(() => replies.length > 0, 4000);
    expect(replies.length).toBeGreaterThan(0);
    expect(replies[0]).toMatch(/cross the road/i);
  });

  it("sends ASK followed immediately by a text frame", async () => {
    await connected();
    link.ask("what is your name?");
    await until(() => seen.length > 2, 1500);
    const askIdx = seen.findIndex((p) => p.cmd === CMD.ASK);
    expect(askIdx).toBeGreaterThanOrEqual(0);
  });

  it("speaks a line verbatim", async () => {
    const replies: string[] = [];
    link = makeLink(port);
    link.on("reply", (t) => replies.push(t));
    await until(() => link.connectionState === "connected", 3000);

    link.speak("battery low");
    await until(() => replies.length > 0, 4000);
    expect(replies[0]).toBe("battery low");
  });

  it("dances and returns to idle", async () => {
    const l = await connected();
    l.simple(CMD.DANCE);
    await until(() => l.robotStatus.stateCode === ROBOT_STATE.DANCING, 2000);
    expect(l.robotStatus.stateCode).toBe(ROBOT_STATE.DANCING);
    await until(() => l.robotStatus.stateCode === ROBOT_STATE.IDLE, 6000);
  });

  it("toggles autonomous mode", async () => {
    const l = await connected();
    l.setAutonomous(true);
    // Autonomous is reported through the robot's own state, so the app does
    // not need a separate flag from the firmware.
    await until(() => l.robotStatus.autonomous, 3000);
    expect(l.robotStatus.autonomous).toBe(true);
    expect(l.robotStatus.state).toBe("exploring");

    l.setAutonomous(false);
    await until(() => !l.robotStatus.autonomous, 3000);
    expect(l.robotStatus.autonomous).toBe(false);
  });

  it("sets an expression", async () => {
    await connected();
    link.setExpression(CMD.EXPR_SURPRISED);
    await until(() => seen.some((p) => p.cmd === CMD.EXPR_SURPRISED), 1500);
    expect(seen.some((p) => p.cmd === CMD.EXPR_SURPRISED)).toBe(true);
  });

  it("reads the cliff sensor and exposes ground distance", async () => {
    const l = await connected();
    l.readSensor();
    await until(() => l.robotStatus.groundCm > 0, 2000);
    expect(l.robotStatus.groundCm).toBe(12);
    expect(l.robotStatus.cliff).toBe(CLIFF.GROUND);
    expect(l.robotStatus.cliffName).toBe("ground");
  });

  it("surfaces a cliff refusal and stops driving", async () => {
    const l = await connected();
    const refusals: number[] = [];
    l.on("refused", (code) => refusals.push(code));

    l.drive(CMD.MOVE_FORWARD, true);
    await until(() => robot.isDriving, 1500);

    // Walking over the table edge: the robot refuses and stops itself.
    robot.setCliff(CLIFF.DROP, 40);
    await until(() => refusals.includes(ERR.CLIFF), 3000);
    expect(refusals).toContain(ERR.CLIFF);
    // The wording comes straight from the firmware's own error table, so
    // the app never invents its own phrasing for a safety refusal.
    expect(l.blocked).toMatch(/edge/i);
    expect(robot.isDriving).toBe(false);
    l.drive(CMD.STOP, false);
  });

  it("clears a fault block raised by an ERROR frame, not only by a status frame", async () => {
    // The block used to be cleared by matching text in the message, so a
    // block set from the robot's ERROR frame outlived the fault: the UI kept
    // claiming a dead sensor long after the robot was safe again.
    const l = await connected();
    const refusals: number[] = [];
    l.on("refused", (code) => refusals.push(code));

    robot.setCliff(CLIFF.FAULT, 0);
    await until(() => refusals.includes(ERR.SENSOR_FAULT), 3000);
    expect(l.blocked).not.toBeNull();

    // A safe reading must lift it, even though the fault was reported as an
    // error rather than as a CLIFF status frame.
    robot.setCliff(CLIFF.GROUND, 12);
    await until(() => l.blocked === null, 3000);
    expect(l.blocked).toBeNull();
  });

  it("keeps a sensor block while the fault persists, despite acks", async () => {
    // An ACK for a harmless command must not hide a real edge.
    const l = await connected();
    robot.setCliff(CLIFF.DROP, 44);
    await until(() => l.blocked !== null, 3000);

    l.simple(CMD.DANCE);
    l.simple(CMD.IDLE);
    await new Promise((r) => setTimeout(r, 500));
    expect(l.blocked).not.toBeNull();
  });

  it("refuses a movement command while a cliff is detected", async () => {
    const l = await connected();
    const refusals: number[] = [];
    l.on("refused", (code) => refusals.push(code));

    robot.setCliff(CLIFF.DROP, 44);
    await until(() => l.robotStatus.cliff === CLIFF.DROP, 3000);

    l.drive(CMD.MOVE_FORWARD, true);
    await until(() => refusals.includes(ERR.CLIFF), 3000);
    expect(refusals).toContain(ERR.CLIFF);
    expect(robot.isDriving).toBe(false);
    l.drive(CMD.STOP, false);
  });

  it("surfaces a sensor fault refusal", async () => {
    const l = await connected();
    const refusals: number[] = [];
    l.on("refused", (code) => refusals.push(code));

    robot.setCliff(CLIFF.FAULT, 0);
    await until(() => refusals.includes(ERR.SENSOR_FAULT), 3000);
    expect(refusals).toContain(ERR.SENSOR_FAULT);
    expect(l.blocked).toMatch(/sensor/i);
  });

  it("recovers once the cliff is clear again", async () => {
    const l = await connected();
    const refusals: number[] = [];
    l.on("refused", (code) => refusals.push(code));

    robot.setCliff(CLIFF.DROP, 40);
    await until(() => refusals.includes(ERR.CLIFF), 3000);
    robot.setCliff(CLIFF.GROUND, 12);
    await until(() => l.blocked === null, 3000);
    expect(l.blocked).toBeNull();
  });

  it("drives again after a cliff clears", async () => {
    const l = await connected();
    robot.setCliff(CLIFF.DROP, 44);
    await until(() => l.blocked !== null, 3000);

    robot.setCliff(CLIFF.GROUND, 12);
    await until(() => l.blocked === null, 3000);

    // The important part: a recovered robot actually moves again.
    l.drive(CMD.MOVE_FORWARD, true);
    await until(() => robot.isDriving, 3000);
    expect(robot.isDriving).toBe(true);
    l.drive(CMD.STOP, false);
  });

  it("reports a watchdog stop as a notice, not a disconnect", async () => {
    const l = await connected();
    const refusals: number[] = [];
    l.on("refused", (code) => refusals.push(code));

    // Drive, then go silent: the robot must stop itself.
    l.drive(CMD.MOVE_FORWARD, true);
    await until(() => robot.isDriving, 1500);

    // Silence the app without tearing the socket down. Replacing the private
    // method after the timer is armed means the existing interval keeps
    // firing an empty callback, so no packets reach the robot and the real
    // 700 ms watchdog expires on its own.
    const internals = l as unknown as {
      keepaliveTimer: NodeJS.Timeout | null;
      startKeepalive: () => void;
    };
    if (internals.keepaliveTimer) clearInterval(internals.keepaliveTimer);
    internals.keepaliveTimer = null;
    internals.startKeepalive = () => {};

    await until(() => refusals.includes(ERR.LINK_TIMEOUT), 4000);
    expect(refusals).toContain(ERR.LINK_TIMEOUT);
    // The point of the test: a watchdog stop must NOT look like a lost link,
    // because the app is still connected and only needs to resume sending.
    expect(l.connectionState).toBe("connected");
    expect(robot.isDriving).toBe(false);
  });

  it("reports offline when the robot disappears", async () => {
    const l = await connected();
    await robot.stop();
    await until(() => l.connectionState === "disconnected", 3000);
    expect(l.connectionState).toBe("disconnected");
  });

  it("sends BYE on a clean disconnect so the robot stops immediately", async () => {
    const l = await connected();
    l.disconnect("bye test");
    // The write is flushed before the socket closes, so allow a moment for
    // the robot to receive it.
    await until(() => seen.some((p) => p.cmd === CMD.BYE), 2000);
    expect(seen.some((p) => p.cmd === CMD.BYE)).toBe(true);
  });
});

describe("RobotLink framing against a hostile stream", () => {
  let server: net.Server;
  let port: number;
  let live: RobotLink | null = null;
  const clients = new Set<net.Socket>();
  let push: (b: Buffer) => void = () => {};

  beforeEach(async () => {
    server = net.createServer((socket) => {
      clients.add(socket);
      socket.on("close", () => clients.delete(socket));
      socket.on("data", () => {});
      push = (b) => socket.write(b);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterEach(async () => {
    // The link keeps a reconnect timer and a keepalive; close it first, then
    // drop the raw sockets, or server.close() waits on them forever.
    live?.disconnect("test teardown");
    live = null;
    for (const c of clients) c.destroy();
    clients.clear();
    await new Promise<void>((done) => server.close(() => done()));
  });

  async function liveLink(): Promise<RobotLink> {
    const l = new RobotLink({ reconnect: { enabled: false, minDelayMs: 20, maxDelayMs: 40 } });
    live = l;
    l.connect("127.0.0.1", port);
    await until(() => l.connectionState === "connected", 3000);
    return l;
  }

  it("resynchronises on the magic byte after garbage", async () => {
    const l = await liveLink();
    push(Buffer.from([0x00, 0x13, 0xff, 0x99]));
    push(Buffer.from(encodePacket({ type: MSG_TYPE.STATUS, cmd: ST.ROBOT_STATE, value: 1 }, 0)));
    await until(() => l.robotStatus.stateCode === 1, 2000);
    expect(l.robotStatus.stateCode).toBe(1);
  });

  it("ignores a status frame with a bad magic byte", async () => {
    const l = await liveLink();
    const before = l.robotStatus.stateCode;
    const bad = Buffer.from(encodePacket({ type: MSG_TYPE.STATUS, cmd: ST.ROBOT_STATE, value: 6 }, 0));
    bad[0] = 0x00;
    push(bad);
    await new Promise((r) => setTimeout(r, 300));
    expect(l.robotStatus.stateCode).toBe(before);
  });

  it("ignores a command frame arriving from the robot", async () => {
    const l = await liveLink();
    const before = l.robotStatus.stateCode;
    push(
      Buffer.from(
        encodePacket({ type: MSG_TYPE.COMMAND, cmd: CMD.MOVE_FORWARD, flags: 1 }, 0),
      ),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(l.robotStatus.stateCode).toBe(before);
  });

  it("survives a very large chunk without crashing", async () => {
    const l = await liveLink();
    const noise = Buffer.alloc(64 * 1024, 0x00);
    push(noise);
    push(Buffer.from(encodePacket({ type: MSG_TYPE.STATUS, cmd: ST.PONG, value: 1 }, 0)));
    await new Promise((r) => setTimeout(r, 400));
    expect(l.connectionState).toBe("connected");
  });

  it("handles a text frame split byte by byte", async () => {
    const l = await liveLink();
    const replies: string[] = [];
    l.on("reply", (t) => replies.push(t));

    const header = Buffer.from([0xa5, 0x01, 0x03, 0x03, 0x00]);
    const len = Buffer.from([5, 0x00, 0x00]);
    const payload = Buffer.from("hello", "utf8");
    for (const byte of [...header, ...len, ...payload]) push(Buffer.from([byte]));

    await until(() => replies.length > 0, 2000);
    expect(replies[0]).toBe("hello");
  });
});
