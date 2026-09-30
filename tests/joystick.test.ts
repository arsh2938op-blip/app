import { describe, expect, it } from "vitest";
import {
  resolveDirection,
  directionToCommand,
  type StickDirection,
} from "../src/client/ui/Joystick.js";
import { CMD } from "../src/shared/walleProtocol.js";

const R = 100;

/** Centre, and the four cardinal points at full deflection. */
describe("joystick direction resolution", () => {
  it("reports nothing in the dead zone", () => {
    expect(resolveDirection(0, 0, R)).toBeNull();
    expect(resolveDirection(5, 5, R)).toBeNull();
    // 28% of the radius is the dead zone, so 27 is inside and 29 is not.
    expect(resolveDirection(-19, 19, R)).toBeNull();
    expect(resolveDirection(-29, 29, R)).not.toBeNull();
  });

  it("resolves forward when pushed up", () => {
    expect(resolveDirection(0, -80, R)).toBe("forward");
  });

  it("resolves backward when pushed down", () => {
    expect(resolveDirection(0, 80, R)).toBe("backward");
  });

  it("resolves rotation when pushed purely sideways", () => {
    expect(resolveDirection(-80, 0, R)).toBe("left");
    expect(resolveDirection(80, 0, R)).toBe("right");
  });

  it("resolves an arc when pushed forward and to the side", () => {
    expect(resolveDirection(-60, -60, R)).toBe("forward_left");
    expect(resolveDirection(60, -60, R)).toBe("forward_right");
  });

  it("resolves a reverse arc when pushed back and to the side", () => {
    expect(resolveDirection(-60, 60, R)).toBe("backward_left");
    expect(resolveDirection(60, 60, R)).toBe("backward_right");
  });

  it("treats screen-down as backward, not forward", () => {
    // y grows downward on screen; WALL-E's forward is up the screen.
    expect(resolveDirection(0, 80, R)).toBe("backward");
    expect(resolveDirection(0, -80, R)).toBe("forward");
  });
});

describe("joystick direction to command mapping", () => {
  const cases: [StickDirection | null, number | null][] = [
    ["forward", CMD.MOVE_FORWARD],
    ["backward", CMD.MOVE_BACKWARD],
    ["forward_left", CMD.TURN_LEFT],
    ["forward_right", CMD.TURN_RIGHT],
    ["backward_left", CMD.TURN_LEFT],
    ["backward_right", CMD.TURN_RIGHT],
    ["left", CMD.ROTATE_LEFT],
    ["right", CMD.ROTATE_RIGHT],
    [null, null],
  ];

  for (const [dir, cmd] of cases) {
    it(`maps ${String(dir)} to ${cmd === null ? "stop" : `0x${cmd.toString(16)}`}`, () => {
      expect(directionToCommand(dir)).toBe(cmd);
    });
  }

  it("never maps a direction to stop", () => {
    for (const [dir] of cases) {
      if (dir === null) continue;
      expect(directionToCommand(dir)).not.toBe(CMD.STOP);
    }
  });

  it("only ever picks from the six held direction commands", () => {
    const allowed = new Set<number>([
      CMD.MOVE_FORWARD,
      CMD.MOVE_BACKWARD,
      CMD.TURN_LEFT,
      CMD.TURN_RIGHT,
      CMD.ROTATE_LEFT,
      CMD.ROTATE_RIGHT,
    ]);
    for (const [dir] of cases) {
      const cmd = directionToCommand(dir);
      if (cmd === null) continue;
      expect(allowed.has(cmd)).toBe(true);
    }
  });
});

describe("joystick dead zone behaviour", () => {
  it("is continuous: every point in the circle resolves to something valid", () => {
    for (let a = 0; a < 360; a += 5) {
      for (const dist of [0, 10, 30, 50, 80, 100]) {
        const rad = (a * Math.PI) / 180;
        const dir = resolveDirection(Math.cos(rad) * dist, Math.sin(rad) * dist, R);
        expect(
          dir === null || typeof dir === "string",
          `angle ${a} dist ${dist} gave ${dir}`,
        ).toBe(true);
      }
    }
  });

  it("holds direction continuously along a circle once outside the dead zone", () => {
    // Once past the dead zone the resolved direction must not flicker as the
    // finger jitters, so a full revolution yields exactly four arc segments
    // plus the four cardinals.
    const seen = new Set<StickDirection | null>();
    for (let a = 0; a < 360; a += 1) {
      const rad = (a * Math.PI) / 180;
      seen.add(resolveDirection(Math.cos(rad) * 90, Math.sin(rad) * 90, R));
    }
    expect(seen.size).toBe(8);
  });
});
