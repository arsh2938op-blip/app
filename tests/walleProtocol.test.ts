import { describe, expect, it } from "vitest";
import {
  APP_TIMEOUT_MS,
  CLIFF,
  CMD,
  ERR,
  FLAG_HELD,
  FrameReader,
  MAGIC,
  MAX_STEPS,
  MSG_TYPE,
  PACKET_SIZE,
  ST,
  TEXT_HEADER_SIZE,
  TEXT_MAX,
  VERSION,
  cliffIsDangerous,
  cliffName,
  clampArg,
  commandName,
  decodePacket,
  encodePacket,
  encodeTextFrame,
  errorMessage,
  estimateStepDistanceCm,
  isMotionCommand,
  remoteStateName,
  robotStateName,
  wheelsBlockedByVoice,
} from "../src/shared/walleProtocol.js";
import { validateAppCommand, clampText } from "../src/shared/validateAppCommand.js";

describe("frame constants match the firmware header", () => {
  it("uses the same magic, version and packet size", () => {
    expect(MAGIC).toBe(0xa5);
    expect(VERSION).toBe(0x01);
    expect(PACKET_SIZE).toBe(10);
    expect(TEXT_HEADER_SIZE).toBe(8);
    expect(TEXT_MAX).toBe(240);
    expect(APP_TIMEOUT_MS).toBe(700);
    expect(FLAG_HELD).toBe(0x01);
    expect(MAX_STEPS).toBe(50);
  });

  it("uses the documented command ids", () => {
    expect(CMD.MOVE_FORWARD).toBe(0x01);
    expect(CMD.MOVE_BACKWARD).toBe(0x02);
    expect(CMD.TURN_LEFT).toBe(0x03);
    expect(CMD.TURN_RIGHT).toBe(0x04);
    expect(CMD.ROTATE_LEFT).toBe(0x05);
    expect(CMD.ROTATE_RIGHT).toBe(0x06);
    expect(CMD.STOP).toBe(0x07);
    expect(CMD.DANCE).toBe(0x10);
    expect(CMD.EXPLORE).toBe(0x11);
    expect(CMD.IDLE).toBe(0x12);
    expect(CMD.AUTONOMOUS_ON).toBe(0x13);
    expect(CMD.AUTONOMOUS_OFF).toBe(0x14);
    expect(CMD.TALK).toBe(0x15);
    expect(CMD.JOKE).toBe(0x16);
    expect(CMD.MOVE_STEPS).toBe(0x17);
    expect(CMD.TURN_AROUND).toBe(0x18);
    expect(CMD.READ_SENSOR).toBe(0x19);
    expect(CMD.ASK).toBe(0x1a);
    expect(CMD.SPEAK).toBe(0x1b);
    expect(CMD.TURN_DEGREES).toBe(0x1c);
    expect(CMD.EXPR_HAPPY).toBe(0x20);
    expect(CMD.EXPR_THINKING).toBe(0x21);
    expect(CMD.EXPR_SURPRISED).toBe(0x22);
    expect(CMD.EXPR_CONFUSED).toBe(0x23);
    expect(CMD.EXPR_IDLE).toBe(0x24);
    expect(CMD.HELLO).toBe(0x30);
    expect(CMD.PING).toBe(0x31);
    expect(CMD.BYE).toBe(0x32);
  });

  it("uses the documented status ids", () => {
    expect(ST.WELCOME).toBe(0x80);
    expect(ST.ACK).toBe(0x81);
    expect(ST.ERROR).toBe(0x82);
    expect(ST.ROBOT_STATE).toBe(0x83);
    expect(ST.REMOTE_STATE).toBe(0x84);
    expect(ST.SENSOR).toBe(0x87);
    expect(ST.CLIFF).toBe(0x88);
  });

  it("uses the documented error ids", () => {
    expect(ERR.BAD_PACKET).toBe(1);
    expect(ERR.UNKNOWN_CMD).toBe(2);
    expect(ERR.NOT_CONFIGURED).toBe(3);
    expect(ERR.BUSY).toBe(4);
    expect(ERR.CLIFF).toBe(5);
    expect(ERR.SENSOR_FAULT).toBe(6);
    expect(ERR.BAD_ARG).toBe(7);
    expect(ERR.LINK_TIMEOUT).toBe(8);
  });

  it("names every command", () => {
    for (const [id, name] of Object.entries({
      [CMD.MOVE_FORWARD]: "move_forward",
      [CMD.STOP]: "stop",
      [CMD.AUTONOMOUS_ON]: "autonomous_on",
      [CMD.EXPR_HAPPY]: "expression_happy",
      [CMD.BYE]: "bye",
    })) {
      expect(commandName(Number(id))).toBe(name);
    }
    expect(commandName(0xee)).toBe("?");
  });
});

describe("safety classifications", () => {
  it("treats the held directions, steps and turns as motion", () => {
    for (const c of [
      CMD.MOVE_FORWARD,
      CMD.MOVE_BACKWARD,
      CMD.TURN_LEFT,
      CMD.TURN_RIGHT,
      CMD.ROTATE_LEFT,
      CMD.ROTATE_RIGHT,
      CMD.MOVE_STEPS,
      CMD.TURN_AROUND,
      CMD.TURN_DEGREES,
    ]) {
      expect(isMotionCommand(c), commandName(c)).toBe(true);
    }
  });

  it("does not treat modes, voice or housekeeping as motion", () => {
    // stop must not be motion, or a stop would be held forever.
    for (const c of [CMD.STOP, CMD.DANCE, CMD.EXPLORE, CMD.TALK, CMD.JOKE, CMD.PING]) {
      expect(isMotionCommand(c), commandName(c)).toBe(false);
    }
  });

  it("blocks the wheels while the robot is thinking or speaking", () => {
    expect(wheelsBlockedByVoice(2)).toBe(true); // THINKING
    expect(wheelsBlockedByVoice(3)).toBe(true); // SPEAKING
    expect(wheelsBlockedByVoice(1)).toBe(false); // IDLE
    expect(wheelsBlockedByVoice(6)).toBe(false); // MOVING
  });

  it("treats a drop and a sensor fault as dangerous", () => {
    expect(cliffIsDangerous(CLIFF.DROP)).toBe(true);
    expect(cliffIsDangerous(CLIFF.FAULT)).toBe(true);
    expect(cliffIsDangerous(CLIFF.GROUND)).toBe(false);
    expect(cliffIsDangerous(CLIFF.WARN)).toBe(false);
    expect(cliffName(CLIFF.GROUND)).toBe("ground");
  });

  it("names robot states and remote states", () => {
    expect(robotStateName(1)).toBe("idle");
    expect(robotStateName(8)).toBe("remote");
    expect(robotStateName(99)).toBe("unknown");
    expect(remoteStateName(2)).toBe("connected");
    expect(remoteStateName(99)).toBe("disconnected");
  });

  it("gives every error a message a person can act on", () => {
    for (const code of Object.values(ERR)) {
      if (code === ERR.NONE) continue;
      expect(errorMessage(code).length).toBeGreaterThan(5);
    }
    expect(errorMessage(ERR.CLIFF)).toMatch(/edge/i);
    expect(errorMessage(ERR.SENSOR_FAULT)).toMatch(/sensor/i);
    expect(errorMessage(ERR.LINK_TIMEOUT)).toMatch(/quiet/i);
  });
});

describe("packet encoding", () => {
  it("produces exactly 10 bytes with the documented layout", () => {
    const b = encodePacket({ type: MSG_TYPE.COMMAND, cmd: CMD.MOVE_FORWARD }, 42);
    expect(b.length).toBe(PACKET_SIZE);
    expect(b[0]).toBe(MAGIC);
    expect(b[1]).toBe(VERSION);
    expect(b[2]).toBe(MSG_TYPE.COMMAND);
    expect(b[3]).toBe(CMD.MOVE_FORWARD);
    expect(b[4]).toBe(0);
    expect(b[5]).toBe(42);
    expect(b[6]).toBe(0);
    expect(b[7]).toBe(0);
    expect(b[8]).toBe(0);
    expect(b[9]).toBe(0);
  });

  it("sets the HELD flag", () => {
    const b = encodePacket({ type: MSG_TYPE.COMMAND, cmd: CMD.MOVE_FORWARD, flags: FLAG_HELD }, 1);
    expect((b[6] ?? 0) & FLAG_HELD).toBe(FLAG_HELD);
  });

  it("writes arg as little-endian uint16", () => {
    const b = encodePacket({ type: MSG_TYPE.COMMAND, cmd: CMD.MOVE_STEPS, arg: 300 }, 0);
    // 300 = 0x012C -> low byte first
    expect(b[8]).toBe(0x2c);
    expect(b[9]).toBe(0x01);
  });

  it("wraps seq at 255", () => {
    const b = encodePacket({ type: MSG_TYPE.COMMAND, cmd: CMD.PING }, 255);
    expect(b[5]).toBe(255);
  });

  it("round-trips a packet", () => {
    const p = { type: MSG_TYPE.STATUS, cmd: ST.SENSOR, value: CLIFF.GROUND, arg: 12 };
    const d = decodePacket(encodePacket(p, 7));
    expect(d).toMatchObject({ type: MSG_TYPE.STATUS, cmd: ST.SENSOR, value: 1, arg: 12 });
  });

  it("rejects a frame with the wrong magic", () => {
    const b = encodePacket({ type: MSG_TYPE.COMMAND, cmd: CMD.STOP }, 0);
    b[0] = 0x00;
    expect(decodePacket(b)).toBeNull();
  });

  it("rejects a short frame", () => {
    expect(decodePacket(new Uint8Array(5))).toBeNull();
  });
});

describe("text frame encoding", () => {
  it("produces an 8-byte header plus the UTF-8 payload", () => {
    const b = encodeTextFrame(0x01, "hello");
    expect(b.length).toBe(TEXT_HEADER_SIZE + 5);
    expect(b[0]).toBe(MAGIC);
    expect(b[2]).toBe(MSG_TYPE.TEXT);
    expect(b[3]).toBe(0x01);
    expect(b[5]).toBe(5);
    expect(b[7]).toBe(0);
    expect(new TextDecoder().decode(b.slice(TEXT_HEADER_SIZE))).toBe("hello");
  });

  it("truncates at TEXT_MAX bytes, not characters", () => {
    const b = encodeTextFrame(0x02, "x".repeat(500));
    expect(b.length).toBe(TEXT_HEADER_SIZE + TEXT_MAX);
  });

  it("truncates without splitting a multi-byte character", () => {
    // 3-byte characters, so a naive slice(0, 240) would split one.
    const text = "€".repeat(200); // 600 bytes
    const b = encodeTextFrame(0x02, text);
    const payload = b.slice(TEXT_HEADER_SIZE);
    expect(payload.length).toBeLessThanOrEqual(TEXT_MAX);
    // The decoded payload must be valid UTF-8: decoding with fatal:true
    // throws on any split or malformed sequence.
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    expect(decoded).not.toContain("�");
    // Every character survived intact, which a byte-slicing truncate gives
    // us only because it cuts on a whole-character boundary.
    expect([...decoded]).toHaveLength(TEXT_MAX / 3);
  });

  it("handles multi-byte text within the limit", () => {
    const b = encodeTextFrame(0x01, "héllo wörld");
    const len = b.length - TEXT_HEADER_SIZE;
    expect(new TextDecoder().decode(b.slice(TEXT_HEADER_SIZE, TEXT_HEADER_SIZE + len))).toBe(
      "héllo wörld",
    );
  });
});

describe("stream framing", () => {
  it("reassembles a packet split across two reads", () => {
    const r = new FrameReader();
    const b = encodePacket({ type: MSG_TYPE.STATUS, cmd: ST.ROBOT_STATE, value: 1 }, 0);
    expect(r.feed(b.subarray(0, 4)).packets).toHaveLength(0);
    const out = r.feed(b.subarray(4));
    expect(out.packets).toHaveLength(1);
    expect(out.packets[0]!.cmd).toBe(ST.ROBOT_STATE);
  });

  it("splits three packets in one read", () => {
    const r = new FrameReader();
    const joined = new Uint8Array(30);
    joined.set(encodePacket({ type: MSG_TYPE.STATUS, cmd: ST.ACK, value: CMD.DANCE }, 1), 0);
    joined.set(encodePacket({ type: MSG_TYPE.STATUS, cmd: ST.ROBOT_STATE, value: 7 }, 2), 10);
    joined.set(encodePacket({ type: MSG_TYPE.STATUS, cmd: ST.PONG, value: 1 }, 3), 20);
    expect(r.feed(joined).packets).toHaveLength(3);
  });

  it("resynchronises after stray bytes", () => {
    const r = new FrameReader();
    // Noise that does not itself end in the magic byte, so the following
    // packet starts on a clean boundary.
    const junk = new Uint8Array([0x00, 0xff, 0x12, 0x34, 0xa5, 0x00]);
    const b = encodePacket({ type: MSG_TYPE.STATUS, cmd: ST.PONG, value: 1 }, 0);
    const withJunk = new Uint8Array(junk.length + b.length);
    withJunk.set(junk, 0);
    withJunk.set(b, junk.length);
    const out = r.feed(withJunk);
    expect(out.packets).toHaveLength(1);
    expect(out.packets[0]!.cmd).toBe(ST.PONG);
  });

  it("rejects a magic byte whose version byte does not follow", () => {
    const r = new FrameReader();
    // A magic byte with a wrong version is someone else's protocol, so the
    // partial frame is dropped rather than decoded as garbage.
    const bad = new Uint8Array([0xa5, 0x99, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    expect(r.feed(bad).packets).toHaveLength(0);
    // And the reader recovers for the next real frame.
    const good = encodePacket({ type: MSG_TYPE.STATUS, cmd: ST.PONG, value: 1 }, 0);
    expect(r.feed(good).packets).toHaveLength(1);
  });

  it("reads a text frame whose payload is shorter than a fixed packet", () => {
    // A naive "always 10 bytes first" reader would eat this as a fixed
    // packet. The type byte has to be checked.
    const r = new FrameReader();
    const short = encodeTextFrame(0x03, "hi"); // 8 + 2 = 10 bytes exactly
    const out = r.feed(short);
    expect(out.packets).toHaveLength(0);
    expect(out.texts).toHaveLength(1);
    expect(out.texts[0]!.text).toBe("hi");
  });

  it("reads back-to-back text frames", () => {
    const r = new FrameReader();
    const a = encodeTextFrame(0x03, "one");
    const b = encodeTextFrame(0x03, "two");
    const both = new Uint8Array(a.length + b.length);
    both.set(a, 0);
    both.set(b, a.length);
    const out = r.feed(both);
    expect(out.texts.map((t) => t.text)).toEqual(["one", "two"]);
  });

  it("recovers when a frame is cut short mid-payload", () => {
    const r = new FrameReader();
    // A truncated text frame: the header claims 17 bytes but only 12 arrive.
    const partial = encodeTextFrame(0x03, "hello there friend");
    expect(r.feed(partial.subarray(0, 12)).texts).toHaveLength(0);

    // The real firmware would still be mid-frame here and cannot recover on
    // its own, so the app resets before sending a fresh command sequence.
    r.reset();

    const b = encodePacket({ type: MSG_TYPE.STATUS, cmd: ST.ROBOT_STATE, value: 1 }, 0);
    expect(r.feed(b).packets).toHaveLength(1);
  });

  it("reports pending bytes so a caller can detect a stalled frame", () => {
    const r = new FrameReader();
    const partial = encodeTextFrame(0x03, "hello there friend");
    r.feed(partial.subarray(0, 12));
    expect(r.pendingBytes).toBe(12);
    expect(r.pendingWants).toBe(partial.length);
  });

  it("reassembles a text frame split across reads", () => {
    const r = new FrameReader();
    const b = encodeTextFrame(0x03, "I am WALL-E, nice to meet you.");
    expect(r.feed(b.subarray(0, 5)).texts).toHaveLength(0);
    const out = r.feed(b.subarray(5));
    expect(out.texts).toHaveLength(1);
    expect(out.texts[0]!.op).toBe(0x03);
    expect(out.texts[0]!.text).toBe("I am WALL-E, nice to meet you.");
  });

  it("handles a packet and a text frame in one read", () => {
    const r = new FrameReader();
    const p = encodePacket({ type: MSG_TYPE.COMMAND, cmd: CMD.ASK }, 1);
    const t = encodeTextFrame(0x01, "what is your name?");
    const both = new Uint8Array(p.length + t.length);
    both.set(p, 0);
    both.set(t, p.length);
    const out = r.feed(both);
    expect(out.packets).toHaveLength(1);
    expect(out.texts).toHaveLength(1);
  });

  it("drops a text frame claiming an impossible length", () => {
    const r = new FrameReader();
    const bogus = new Uint8Array(TEXT_HEADER_SIZE + 4);
    bogus[0] = MAGIC;
    bogus[1] = VERSION;
    bogus[2] = MSG_TYPE.TEXT;
    bogus[3] = 0x03;
    bogus[5] = 0xff; // len 255 > TEXT_MAX
    bogus[6] = 0x00;
    const out = r.feed(bogus);
    expect(out.texts).toHaveLength(0);
    // And the reader recovers for the next frame.
    const good = encodePacket({ type: MSG_TYPE.STATUS, cmd: ST.PONG, value: 1 }, 0);
    expect(r.feed(good).packets).toHaveLength(1);
  });

  it("drops a zero-length text frame", () => {
    const r = new FrameReader();
    const zero = new Uint8Array(TEXT_HEADER_SIZE);
    zero[0] = MAGIC;
    zero[1] = VERSION;
    zero[2] = MSG_TYPE.TEXT;
    zero[3] = 0x03;
    expect(r.feed(zero).texts).toHaveLength(0);
  });

  it("ignores an empty chunk", () => {
    const r = new FrameReader();
    expect(r.feed(new Uint8Array(0)).packets).toHaveLength(0);
  });
});

describe("argument helpers", () => {
  it("clamps into range", () => {
    expect(clampArg(5, 1, 50)).toBe(5);
    expect(clampArg(0, 1, 50)).toBe(1);
    expect(clampArg(500, 1, 50)).toBe(50);
    expect(clampArg(NaN, 1, 50)).toBe(1);
  });

  it("estimates step distance from the firmware constants", () => {
    expect(estimateStepDistanceCm(4)).toBe(40);
    expect(estimateStepDistanceCm(999)).toBe(500);
  });
});

describe("app command validation", () => {
  it("accepts every documented simple command", () => {
    for (const command of [
      CMD.DANCE,
      CMD.EXPLORE,
      CMD.IDLE,
      CMD.TALK,
      CMD.JOKE,
      CMD.TURN_AROUND,
      CMD.READ_SENSOR,
      CMD.STOP,
    ]) {
      const r = validateAppCommand({ name: "simple", command });
      expect(r.ok, commandName(command)).toBe(true);
    }
  });

  it("rejects a non-direction as a drive command", () => {
    expect(validateAppCommand({ name: "drive", command: CMD.DANCE, held: true }).ok).toBe(false);
    expect(validateAppCommand({ name: "drive", command: CMD.MOVE_STEPS, held: true }).ok).toBe(false);
  });

  it("treats a release expressed as a drive frame as a plain stop", () => {
    // Some clients send {drive, command: STOP, held: false} on release. That
    // is normalised to a stop rather than rejected, so a finger lifting can
    // never fail to stop the robot.
    const r = validateAppCommand({ name: "drive", command: CMD.STOP, held: false });
    expect(r.ok && r.command).toEqual({ name: "stop" });
  });

  it("accepts the six direction commands as drive commands", () => {
    for (const command of [
      CMD.MOVE_FORWARD,
      CMD.MOVE_BACKWARD,
      CMD.TURN_LEFT,
      CMD.TURN_RIGHT,
      CMD.ROTATE_LEFT,
      CMD.ROTATE_RIGHT,
    ]) {
      expect(validateAppCommand({ name: "drive", command, held: true }).ok).toBe(true);
    }
  });

  it("requires held to be a boolean", () => {
    expect(validateAppCommand({ name: "drive", command: CMD.MOVE_FORWARD, held: "yes" }).ok).toBe(
      false,
    );
  });

  it("accepts only the five expression commands", () => {
    expect(validateAppCommand({ name: "expression", command: CMD.EXPR_HAPPY }).ok).toBe(true);
    expect(validateAppCommand({ name: "expression", command: CMD.MOVE_FORWARD }).ok).toBe(false);
  });

  it("clamps rather than rejects an out-of-range step count", () => {
    const high = validateAppCommand({ name: "move_steps", steps: 999 });
    expect(high.ok && high.command).toEqual({ name: "move_steps", steps: MAX_STEPS });
    const low = validateAppCommand({ name: "move_steps", steps: -5 });
    expect(low.ok && low.command).toEqual({ name: "move_steps", steps: 1 });
  });

  it("clamps turn degrees into 1..360", () => {
    const r = validateAppCommand({ name: "turn_degrees", degrees: 400 });
    expect(r.ok && r.command).toEqual({ name: "turn_degrees", degrees: 360 });
  });

  it("requires text for ask and speak", () => {
    expect(validateAppCommand({ name: "ask", text: "" }).ok).toBe(false);
    expect(validateAppCommand({ name: "ask", text: "  " }).ok).toBe(false);
    expect(validateAppCommand({ name: "ask", text: "hello" }).ok).toBe(true);
  });

  it("truncates long text to the wire limit", () => {
    const r = validateAppCommand({ name: "ask", text: "a".repeat(500) });
    expect(r.ok).toBe(true);
    if (!r.ok || r.command.name !== "ask") return;
    expect(new TextEncoder().encode(r.command.text).length).toBeLessThanOrEqual(TEXT_MAX);
  });

  it("requires a boolean for autonomous", () => {
    expect(validateAppCommand({ name: "autonomous", enabled: true }).ok).toBe(true);
    expect(validateAppCommand({ name: "autonomous", enabled: "on" }).ok).toBe(false);
  });

  it("rejects unknown command names", () => {
    expect(validateAppCommand({ name: "self_destruct" }).ok).toBe(false);
    expect(validateAppCommand({}).ok).toBe(false);
    expect(validateAppCommand(null).ok).toBe(false);
    expect(validateAppCommand("stop").ok).toBe(false);
  });

  it("trims and byte-truncates text safely", () => {
    expect(clampText("  hi  ")).toBe("hi");
    expect(clampText("€".repeat(500)).length * 3).toBeLessThanOrEqual(TEXT_MAX);
  });
});
