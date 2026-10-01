import { describe, expect, it } from "vitest";
import net from "node:net";
import { MockRobot } from "../src/mock/mockRobot.js";
import { RobotCore, type ByteTransport } from "../src/shared/robotCore.js";
import {
  CREATORS,
  PERSONA_PROMPT,
  ROBOT_NAME,
  hasSignature,
  personaPayload,
  withSignature,
} from "../src/shared/persona.js";
import { CMD, TEXT_MAX } from "../src/shared/walleProtocol.js";

async function until<T>(fn: () => T | undefined | false, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  return undefined;
}

/** Stands in for the Android TCP plugin, over a real socket. */
class FakePluginTransport implements ByteTransport {
  private socket: net.Socket | null = null;
  constructor(
    private readonly onData: (chunk: Uint8Array) => void,
    private readonly onClose: (reason: string) => void,
  ) {}

  open(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = new net.Socket();
      this.socket = s;
      s.once("error", reject);
      s.once("close", () => this.onClose("closed by peer"));
      s.once("connect", () => {
        s.off("error", reject);
        s.on("error", () => {});
        s.on("data", (chunk: Buffer) => this.onData(new Uint8Array(chunk)));
        resolve();
      });
      s.connect(port, host);
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
    s.removeAllListeners();
    s.destroy();
  }
}

describe("persona contract", () => {
  it("is the robot's identity", () => {
    expect(ROBOT_NAME).toBe("Vulkan");
    expect(CREATORS).toHaveLength(4);
  });

  it("requires the Friend! signature and a happy tone", () => {
    expect(PERSONA_PROMPT).toMatch(/Friend!/);
    expect(PERSONA_PROMPT).toMatch(/happy and joyful/i);
    expect(PERSONA_PROMPT).toMatch(/never sad/i);
    // Short answers, because TTS on the robot is slow and the demo is live.
    expect(PERSONA_PROMPT).toMatch(/short sentences/i);
  });

  it("fits the 240-byte text frame the protocol allows", () => {
    const bytes = new TextEncoder().encode(personaPayload()).length;
    expect(bytes).toBeLessThanOrEqual(TEXT_MAX);
  });

  it("carries the name, suffix, mood and prompt", () => {
    const parsed = JSON.parse(personaPayload()) as Record<string, string>;
    expect(parsed.n).toBe(ROBOT_NAME);
    expect(parsed.s).toBe("Friend!");
    expect(parsed.m).toBe("happy");
    expect(parsed.p).toBe(PERSONA_PROMPT);
  });

  it("leaves the creators out, because they would overflow the frame", () => {
    // Including all four names pushes the payload to ~297 bytes, and a
    // clipped JSON string would not parse on the robot.
    expect(personaPayload()).not.toContain("Zulkarnain");
  });
});

describe("reply signature", () => {
  it("detects a reply that already signed off", () => {
    expect(hasSignature("I am Vulkan, nice to meet you! Friend!")).toBe(true);
    expect(hasSignature("I am Vulkan. friend!")).toBe(true);
    expect(hasSignature("I am Vulkan.")).toBe(false);
  });

  it("adds the signature for the transcript when firmware forgets it", () => {
    expect(withSignature("I am Vulkan.")).toBe("I am Vulkan. Friend!");
  });

  it("leaves a correct reply alone", () => {
    expect(withSignature("Hi! Friend!")).toBe("Hi! Friend!");
  });

  it("ignores empty text rather than returning a bare Friend!", () => {
    expect(withSignature("   ")).toBe("");
  });
});

describe("direct link, as the phone runs it", () => {
  /**
   * A whole link, built per test.
   *
   * Deliberately self-contained rather than assembled in beforeEach: the
   * shared mutable `core` made each test depend on the previous one's
   * deferred teardown, which is not a property worth testing for.
   */
  async function linked() {
    const robot = new MockRobot({ port: 0, host: "127.0.0.1" });
    const port = await robot.start();

    const replies: string[] = [];
    const acked: number[] = [];
    const refusals: string[] = [];

    let core!: RobotCore;
    const transport = new FakePluginTransport(
      (chunk) => core.ingest(chunk),
      (reason) => core.handleClose(reason),
    );

    core = new RobotCore(
      transport,
      { reconnect: { enabled: false, minDelayMs: 20, maxDelayMs: 40 } },
      {
        onReply: (t) => replies.push(t),
        onAck: (cmd) => acked.push(cmd),
        onRefused: (code, message) => refusals.push(`${code}: ${message}`),
      },
    );

    core.connect("127.0.0.1", port);
    await until(() => core.connectionState === "connected", 5000);

    return {
      core,
      robot,
      port,
      replies,
      acked,
      refusals,
      async close() {
        core.disconnect("test cleanup");
        transport.close();
        await robot.stop();
      },
    };
  }

  it("connects straight to the robot with no companion server", async () => {
    const l = await linked();
    expect(l.core.connectionState).toBe("connected");
    expect(l.core.target).toEqual({ host: "127.0.0.1", port: l.port });
    await l.close();
  });

  it("sends the persona on connect", async () => {
    const l = await linked();
    expect(await until(() => l.acked.includes(CMD.SET_PERSONA), 5000)).toBeDefined();
    // The robot took the identity, so Gemini will answer in Vulkan's voice.
    expect(l.robot.name).toBe(ROBOT_NAME);
    await l.close();
  });

  it("drives and stops over the direct link", async () => {
    const l = await linked();
    l.core.drive(CMD.MOVE_FORWARD, true);
    await until(() => l.robot.isDriving, 5000);
    expect(l.robot.isDriving).toBe(true);

    l.core.stop();
    await until(() => !l.robot.isDriving, 5000);
    expect(l.robot.isDriving).toBe(false);
    await l.close();
  });

  it("carries a question and gets an answer back", async () => {
    const l = await linked();
    l.core.ask("Tell me a joke.");
    await until(() => l.replies.length > 0, 10_000);
    expect(l.replies[0]).toMatch(/charging station/i);
    await l.close();
  });

  it("keeps the 700 ms watchdog fed while driving", async () => {
    const l = await linked();
    l.core.drive(CMD.MOVE_FORWARD, true);
    // Past the watchdog, with no operator input.
    await new Promise((r) => setTimeout(r, 900));
    expect(l.robot.isDriving).toBe(true);
    l.core.stop();
    await l.close();
  });

  it("surfaces a refusal from the robot", async () => {
    const l = await linked();
    l.robot.setCliff(3, 44); // DROP
    await until(() => l.refusals.length > 0, 5000);
    // Wording comes from the firmware's own error table.
    expect(l.refusals[0]).toMatch(/edge/i);
    expect(l.core.blocked).toMatch(/edge|pick it up/i);
    // And it clears once the floor is back, so the UI is not left stale.
    l.robot.setCliff(1, 12);
    await until(() => l.core.blocked === null, 5000);
    expect(l.core.blocked).toBeNull();
    await l.close();
  });
});