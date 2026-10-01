/**
 * WALL-E binary control protocol — TypeScript mirror of
 * `shared/walle_protocol.h` in the ESP32-S3 firmware.
 *
 * This is a BYTE-EXACT mirror of firmware constants. It is not derived
 * from, and does not extend, any earlier JSON protocol. When the firmware
 * header changes, this file changes with it.
 *
 *   Firmware : WAL-E/shared/walle_protocol.h
 *   Spec     : WALL-E/robot_s3/docs/APP_INTEGRATION.md
 *   Tests    : tests/walleProtocol.test.ts asserts every value below
 *
 * The app is a second controller, identical to the ESP-NOW radio remote.
 * There is no app-specific behaviour in the firmware, so there is none here
 * either: if a command means something to the remote, it means the same
 * thing here.
 */

/* ------------------------------------------------------------------ *
 * Frame constants
 * ------------------------------------------------------------------ */

export const MAGIC = 0xa5;
export const VERSION = 0x01;

/** Fixed command/status packet size. Deliberately exact. */
export const PACKET_SIZE = 10;

/** Text frames: 8-byte header + payload. */
export const TEXT_HEADER_SIZE = 8;

/** Hard cap on a text payload, in bytes. The robot truncates beyond this. */
export const TEXT_MAX = 240;

export const MSG_TYPE = {
  COMMAND: 0x01,
  STATUS: 0x02,
  TEXT: 0x03,
} as const;
export type MsgType = (typeof MSG_TYPE)[keyof typeof MSG_TYPE];

export const FLAG_HELD = 0x01;

/** The robot stops itself if the app goes quiet for this long. */
export const APP_TIMEOUT_MS = 700;

/**
 * Re-send cadence for a held direction. The radio remote uses 250 ms; the
 * robot only needs *something* inside APP_TIMEOUT_MS, so 250 ms leaves a
 * comfortable margin for a congested Wi-Fi network.
 */
export const KEEPALIVE_INTERVAL_MS = 250;

/** Idle keepalive when connected but not driving. */
export const PING_INTERVAL_MS = 300;

export const DEFAULT_ROBOT_PORT = 8080;

/* ------------------------------------------------------------------ *
 * Commands (app -> robot)
 * ------------------------------------------------------------------ */

export const CMD = {
  NONE: 0x00,

  MOVE_FORWARD: 0x01,
  MOVE_BACKWARD: 0x02,
  TURN_LEFT: 0x03,
  TURN_RIGHT: 0x04,
  ROTATE_LEFT: 0x05,
  ROTATE_RIGHT: 0x06,
  STOP: 0x07,

  DANCE: 0x10,
  EXPLORE: 0x11,
  IDLE: 0x12,
  AUTONOMOUS_ON: 0x13,
  AUTONOMOUS_OFF: 0x14,
  TALK: 0x15,
  JOKE: 0x16,
  MOVE_STEPS: 0x17,
  TURN_AROUND: 0x18,
  READ_SENSOR: 0x19,
  ASK: 0x1a,
  SPEAK: 0x1b,
  TURN_DEGREES: 0x1c,
  /**
   * Announce the persona, then send it as a TEXT frame.
   *
   * The robot owns Gemini and the speaker, so the personality has to reach
   * the firmware rather than being synthesised in the app. Sending it at
   * runtime means a build does not have to have it compiled in.
   */
  SET_PERSONA: 0x1d,

  EXPR_HAPPY: 0x20,
  EXPR_THINKING: 0x21,
  EXPR_SURPRISED: 0x22,
  EXPR_CONFUSED: 0x23,
  EXPR_IDLE: 0x24,

  HELLO: 0x30,
  PING: 0x31,
  BYE: 0x32,
} as const;
export type CommandId = (typeof CMD)[keyof typeof CMD];

export const COMMAND_NAME: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries({
      [CMD.NONE]: "none",
      [CMD.MOVE_FORWARD]: "move_forward",
      [CMD.MOVE_BACKWARD]: "move_backward",
      [CMD.TURN_LEFT]: "turn_left",
      [CMD.TURN_RIGHT]: "turn_right",
      [CMD.ROTATE_LEFT]: "rotate_left",
      [CMD.ROTATE_RIGHT]: "rotate_right",
      [CMD.STOP]: "stop",
      [CMD.DANCE]: "dance",
      [CMD.EXPLORE]: "explore",
      [CMD.IDLE]: "idle",
      [CMD.AUTONOMOUS_ON]: "autonomous_on",
      [CMD.AUTONOMOUS_OFF]: "autonomous_off",
      [CMD.TALK]: "talk",
      [CMD.JOKE]: "joke",
      [CMD.MOVE_STEPS]: "move_steps",
      [CMD.TURN_AROUND]: "turn_around",
      [CMD.READ_SENSOR]: "read_sensor",
      [CMD.ASK]: "ask",
      [CMD.SPEAK]: "speak",
      [CMD.TURN_DEGREES]: "turn_degrees",
      [CMD.SET_PERSONA]: "set_persona",
      [CMD.EXPR_HAPPY]: "expression_happy",
      [CMD.EXPR_THINKING]: "expression_thinking",
      [CMD.EXPR_SURPRISED]: "expression_surprised",
      [CMD.EXPR_CONFUSED]: "expression_confused",
      [CMD.EXPR_IDLE]: "expression_idle",
      [CMD.HELLO]: "hello",
      [CMD.PING]: "ping",
      [CMD.BYE]: "bye",
    } as Record<number, string>).map(([k, v]) => [Number(k), v]),
  ),
);

export function commandName(cmd: number): string {
  return COMMAND_NAME[cmd] ?? "?";
}

/**
 * True for commands that drive the wheels. These are the ones the robot puts
 * into REMOTE_MANUAL, and the only ones it is allowed to stop on a link
 * timeout. Mirrors `walle_cmd_is_motion()` in the firmware header, including
 * the non-contiguous measured-motion entries — leaving them out would punch a
 * hole in the safety model.
 */
export function isMotionCommand(cmd: number): boolean {
  return (
    (cmd >= CMD.MOVE_FORWARD && cmd <= CMD.ROTATE_RIGHT) ||
    cmd === CMD.MOVE_STEPS ||
    cmd === CMD.TURN_AROUND ||
    cmd === CMD.TURN_DEGREES
  );
}

/**
 * Commands that run to completion on their own. No keepalive, and no `stop`
 * afterwards — sending one is harmless but pointless.
 */
export const TIMED_COMMANDS: ReadonlySet<number> = new Set([
  CMD.MOVE_STEPS,
  CMD.TURN_AROUND,
  CMD.TURN_DEGREES,
]);

/** Commands that must be followed immediately by a text frame. */
export const TEXT_COMMANDS: ReadonlySet<number> = new Set([CMD.ASK, CMD.SPEAK]);

/** The direction commands a joystick can hold. */
export const DIRECTION_COMMANDS: ReadonlySet<number> = new Set([
  CMD.MOVE_FORWARD,
  CMD.MOVE_BACKWARD,
  CMD.TURN_LEFT,
  CMD.TURN_RIGHT,
  CMD.ROTATE_LEFT,
  CMD.ROTATE_RIGHT,
]);

/* ------------------------------------------------------------------ *
 * Status (robot -> app)
 * ------------------------------------------------------------------ */

export const ST = {
  NONE: 0x00,
  WELCOME: 0x80,
  ACK: 0x81,
  ERROR: 0x82,
  ROBOT_STATE: 0x83,
  REMOTE_STATE: 0x84,
  BATTERY: 0x85,
  PONG: 0x86,
  SENSOR: 0x87,
  CLIFF: 0x88,
} as const;
export type StatusId = (typeof ST)[keyof typeof ST];

export const STATUS_NAME: Readonly<Record<number, string>> = Object.freeze({
  [ST.WELCOME]: "welcome",
  [ST.ACK]: "ack",
  [ST.ERROR]: "error",
  [ST.ROBOT_STATE]: "robot_state",
  [ST.REMOTE_STATE]: "remote_state",
  [ST.BATTERY]: "battery",
  [ST.PONG]: "pong",
  [ST.SENSOR]: "sensor",
  [ST.CLIFF]: "cliff",
});

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export const ERR = {
  NONE: 0,
  BAD_PACKET: 1,
  UNKNOWN_CMD: 2,
  NOT_CONFIGURED: 3,
  BUSY: 4,
  CLIFF: 5,
  SENSOR_FAULT: 6,
  BAD_ARG: 7,
  LINK_TIMEOUT: 8,
} as const;
export type ErrorId = (typeof ERR)[keyof typeof ERR];

/**
 * Human wording for each error, taken from the "what the app should show"
 * column of the integration doc. Kept in one place so the UI never invents
 * its own phrasing for a safety refusal.
 */
export const ERROR_MESSAGE: Readonly<Record<number, string>> = Object.freeze({
  [ERR.NONE]: "",
  [ERR.BAD_PACKET]: "Bad packet from the robot — check the connection",
  [ERR.UNKNOWN_CMD]: "WALL-E did not recognise that command",
  [ERR.NOT_CONFIGURED]: "That feature is not wired up on this robot",
  [ERR.BUSY]: "The handheld remote has control of WALL-E",
  [ERR.CLIFF]: "WALL-E stopped at the edge — pick it up or move it back",
  [ERR.SENSOR_FAULT]: "WALL-E's distance sensor is not responding",
  [ERR.BAD_ARG]: "That value was out of range",
  [ERR.LINK_TIMEOUT]: "WALL-E stopped driving because the app went quiet",
});

export function errorMessage(code: number): string {
  return ERROR_MESSAGE[code] ?? `Unknown error ${code}`;
}

/* ------------------------------------------------------------------ *
 * Robot states
 * ------------------------------------------------------------------ */

export const ROBOT_STATE_NAMES = [
  "boot",
  "idle",
  "thinking",
  "speaking",
  "exploring",
  "observing",
  "moving",
  "dancing",
  "remote",
  "offline",
] as const;
export type RobotStateName = (typeof ROBOT_STATE_NAMES)[number];

export const ROBOT_STATE = {
  BOOT: 0,
  IDLE: 1,
  THINKING: 2,
  SPEAKING: 3,
  EXPLORING: 4,
  OBSERVING: 5,
  MOVING: 6,
  DANCING: 7,
  REMOTE: 8,
  OFFLINE: 9,
} as const;

/** Radio remote link state, mirroring WalleRemoteState in the header. */
export const REMOTE_STATE_NAMES = [
  "disconnected",
  "connecting",
  "connected",
  "timeout",
] as const;
export type RemoteStateName = (typeof REMOTE_STATE_NAMES)[number];

export function remoteStateName(value: number): RemoteStateName {
  return REMOTE_STATE_NAMES[value] ?? "disconnected";
}

export function robotStateName(value: number): string {
  return ROBOT_STATE_NAMES[value] ?? "unknown";
}

/**
 * States in which the robot has deliberately blocked its wheels for every
 * controller, because a robot that rolls while talking cannot be heard and
 * cannot be stopped. The UI surfaces this rather than fighting it.
 */
export function wheelsBlockedByVoice(value: number): boolean {
  return value === ROBOT_STATE.THINKING || value === ROBOT_STATE.SPEAKING;
}

/* ------------------------------------------------------------------ *
 * Cliff sensor
 * ------------------------------------------------------------------ */

export const CLIFF = {
  UNKNOWN: 0,
  GROUND: 1,
  WARN: 2,
  DROP: 3,
  FAULT: 4,
} as const;
export type CliffState = (typeof CLIFF)[keyof typeof CLIFF];

export const CLIFF_NAMES = ["unknown", "ground", "warn", "drop", "fault"] as const;

export function cliffName(value: number): string {
  return CLIFF_NAMES[value] ?? "unknown";
}

/** True when the sensor is unhappy enough that WALL-E has stopped. */
export function cliffIsDangerous(value: number): boolean {
  return value === CLIFF.DROP || value === CLIFF.FAULT;
}

/* ------------------------------------------------------------------ *
 * Text frame ops
 * ------------------------------------------------------------------ */

export const OP = {
  ASK: 0x01,
  SPEAK: 0x02,
  REPLY: 0x03,
} as const;

export function textOpName(op: number): string {
  return op === OP.ASK ? "ask" : op === OP.SPEAK ? "speak" : op === OP.REPLY ? "reply" : "?";
}

/* ------------------------------------------------------------------ *
 * Packet encode / decode
 * ------------------------------------------------------------------ */

/**
 * A decoded frame. `value`, `seq`, `flags` and `arg` are always present after
 * decoding, but are optional in the input to `encodePacket` because a caller
 * setting only a command should not have to supply zeroes.
 */
export interface PacketFields {
  type: number;
  cmd: number;
  value?: number;
  seq?: number;
  flags?: number;
  arg?: number;
}

/** A decoded frame with every field resolved, safe to index without checks. */
export interface DecodedPacket {
  type: number;
  cmd: number;
  value: number;
  seq: number;
  flags: number;
  arg: number;
}

/**
 * Build the 10-byte command packet.
 *
 * `DataView`, never a packed struct: C struct padding rules differ between
 * platforms and the firmware asserts this type is exactly 10 bytes.
 */
export function encodePacket(f: PacketFields, seq: number): Uint8Array {
  const b = new Uint8Array(PACKET_SIZE);
  const v = new DataView(b.buffer);
  v.setUint8(0, MAGIC);
  v.setUint8(1, VERSION);
  v.setUint8(2, f.type & 0xff);
  v.setUint8(3, f.cmd & 0xff);
  v.setUint8(4, (f.value ?? 0) & 0xff);
  v.setUint8(5, seq & 0xff);
  v.setUint8(6, (f.flags ?? 0) & 0xff);
  v.setUint8(7, 0); // reserved, always zero
  v.setUint16(8, (f.arg ?? 0) & 0xffff, true); // little endian
  return b;
}

export interface TextFrame {
  op: number;
  text: string;
}

/**
 * Build an 8-byte header plus UTF-8 payload.
 *
 * The payload is truncated on a BYTE boundary at TEXT_MAX, never a character
 * boundary, because cutting a multi-byte sequence mid-character would leave
 * the robot decoding invalid UTF-8. The firmware's own `len` field is what
 * governs framing, so byte truncation is always safe.
 */
export function encodeTextFrame(op: number, text: string): Uint8Array {
  // Truncate on a CHARACTER boundary, not a byte boundary. Slicing the
  // encoded bytes would happily cut a 3-byte character in half and hand the
  // robot invalid UTF-8; decoding the slice back drops the partial character
  // and leaves valid text with a `len` that matches it exactly.
  let bytes = new TextEncoder().encode(text);
  if (bytes.length > TEXT_MAX) {
    bytes = new TextEncoder().encode(
      new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, TEXT_MAX)).replace(/�+$/, ""),
    );
  }
  const b = new Uint8Array(TEXT_HEADER_SIZE + bytes.length);
  const v = new DataView(b.buffer);
  v.setUint8(0, MAGIC);
  v.setUint8(1, VERSION);
  v.setUint8(2, MSG_TYPE.TEXT);
  v.setUint8(3, op & 0xff);
  v.setUint8(4, 0); // flags
  v.setUint16(5, bytes.length, true); // little endian
  v.setUint8(7, 0); // reserved
  b.set(bytes, TEXT_HEADER_SIZE);
  return b;
}

export function decodePacket(bytes: Uint8Array): DecodedPacket | null {
  if (bytes.length < PACKET_SIZE) return null;
  if (bytes[0] !== MAGIC || bytes[1] !== VERSION) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    type: v.getUint8(2),
    cmd: v.getUint8(3),
    value: v.getUint8(4),
    seq: v.getUint8(5),
    flags: v.getUint8(6),
    arg: v.getUint16(8, true),
  };
}

export function decodeTextFrame(bytes: Uint8Array): TextFrame | null {
  if (bytes.length < TEXT_HEADER_SIZE) return null;
  if (bytes[0] !== MAGIC || bytes[1] !== VERSION) return null;
  if (bytes[2] !== MSG_TYPE.TEXT) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const op = v.getUint8(3);
  const len = v.getUint16(5, true);
  if (len === 0 || len > TEXT_MAX) return null;
  if (bytes.length < TEXT_HEADER_SIZE + len) return null;
  return {
    op,
    text: new TextDecoder().decode(bytes.slice(TEXT_HEADER_SIZE, TEXT_HEADER_SIZE + len)),
  };
}

/**
 * Incremental TCP stream framer.
 *
 * TCP has no message boundaries: one read can return half a packet, or three
 * packets plus a stray byte. Bytes are fed in one at a time and only acted on
 * when a whole frame is present. Any byte that is not the magic value is
 * skipped, which is what lets the link resynchronise after a reconnect
 * mid-frame instead of wedging forever.
 */
export class FrameReader {
  private buf = new Uint8Array(TEXT_HEADER_SIZE + TEXT_MAX + PACKET_SIZE);
  private rxLen = 0;
  private rxWant = PACKET_SIZE;
  /**
   * Whether the frame in progress is a text frame. Tracked explicitly
   * because a 10-byte text frame is indistinguishable from a fixed packet
   * by length alone — only the type byte at offset 2 settles it.
   */
  private expectingText = false;

  /** Longest frame we will buffer before declaring the stream corrupt. */
  private static readonly MAX_FRAME = TEXT_HEADER_SIZE + TEXT_MAX + PACKET_SIZE;

  feed(chunk: Uint8Array): { packets: DecodedPacket[]; texts: TextFrame[] } {
    const packets: DecodedPacket[] = [];
    const texts: TextFrame[] = [];

    for (const byte of chunk) {
      if (this.rxLen === 0) {
        if (byte !== MAGIC) continue; // resync on magic
        this.buf[this.rxLen++] = byte;
        this.rxWant = PACKET_SIZE;
        continue;
      }
      if (this.rxLen === 1 && byte !== VERSION) {
        // Magic matched but the version did not: not our frame, so drop the
        // lot rather than decoding 9 bytes of somebody else's protocol.
        this.reset();
        continue;
      }

      if (this.rxLen >= FrameReader.MAX_FRAME) {
        this.reset();
        continue;
      }

      this.buf[this.rxLen++] = byte;

      // Byte 2 is the message type, so the frame's length is knowable as soon
      // as three bytes have arrived. Deciding here — rather than assuming a
      // fixed packet and only looking for a text header at offset 8 — is
      // what lets a 10-byte text frame be read as text instead of being
      // misparsed as one fixed packet.
      if (this.rxLen === 3) {
        this.expectingText = this.buf[2] === MSG_TYPE.TEXT;
        this.rxWant = this.expectingText ? TEXT_HEADER_SIZE : PACKET_SIZE;
      }

      // For a text frame the 8-byte header carries the payload length.
      if (this.expectingText && this.rxLen === TEXT_HEADER_SIZE) {
        const v = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
        const len = v.getUint16(5, true);
        if (len === 0 || len > TEXT_MAX) {
          this.reset();
          continue;
        }
        this.rxWant = TEXT_HEADER_SIZE + len;
      }

      if (this.rxLen < this.rxWant) continue;

      if (this.expectingText) {
        const t = decodeTextFrame(this.buf.subarray(0, this.rxWant));
        if (t) texts.push(t);
      } else {
        const p = decodePacket(this.buf.subarray(0, PACKET_SIZE));
        if (p) packets.push(p);
      }
      this.reset();
    }

    return { packets, texts };
  }

  reset(): void {
    this.rxLen = 0;
    this.rxWant = PACKET_SIZE;
    this.expectingText = false;
  }

  get pendingBytes(): number {
    return this.rxLen;
  }

  get pendingWants(): number {
    return this.rxWant;
  }
}

/* ------------------------------------------------------------------ *
 * Argument bounds
 * ------------------------------------------------------------------ */

/** Mirrors WALLE_MAX_STEPS in include/config.h. */
export const MAX_STEPS = 50;
/** Mirrors STEP_DISTANCE_CM. Used only to show an estimate in the UI. */
export const STEP_DISTANCE_CM = 10;
/** Mirrors MANEUVER_MS_PER_TURN_360. Used only to estimate duration. */
export const MS_PER_TURN_360 = 1400;

export const MAX_TURN_DEGREES = 360;

export function clampArg(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

/** Estimated ground distance for N steps. The robot has no encoders. */
export function estimateStepDistanceCm(steps: number): number {
  return clampArg(steps, 1, MAX_STEPS) * STEP_DISTANCE_CM;
}

/** Estimated time for a turn of N degrees, from the firmware's own constant. */
export function estimateTurnMs(degrees: number): number {
  return Math.round((clampArg(degrees, 1, MAX_TURN_DEGREES) / MAX_TURN_DEGREES) * MS_PER_TURN_360);
}
