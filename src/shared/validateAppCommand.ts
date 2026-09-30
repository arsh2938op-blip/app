/**
 * Outbound command validation, app -> companion server.
 *
 * The server never forwards a command it has not checked itself. A tampered
 * or buggy client therefore cannot ask the robot to do something outside the
 * documented set, and every numeric argument is clamped to the range the
 * firmware accepts.
 */

import {
  CMD,
  DIRECTION_COMMANDS,
  MAX_STEPS,
  MAX_TURN_DEGREES,
  TEXT_MAX,
  clampArg,
  commandName,
  type CommandId,
} from "./walleProtocol.js";
import type { AppCommand } from "./walleTypes.js";

/** Commands with no arguments, safe to forward as-is. */
const SIMPLE_ALLOWED = new Set<number>([
  CMD.DANCE,
  CMD.EXPLORE,
  CMD.IDLE,
  CMD.TALK,
  CMD.JOKE,
  CMD.TURN_AROUND,
  CMD.READ_SENSOR,
  CMD.STOP,
  CMD.HELLO,
  CMD.PING,
  CMD.BYE,
]);

/** The five expression commands the firmware defines. */
const EXPRESSION_ALLOWED = new Set<number>([
  CMD.EXPR_HAPPY,
  CMD.EXPR_THINKING,
  CMD.EXPR_SURPRISED,
  CMD.EXPR_CONFUSED,
  CMD.EXPR_IDLE,
]);

type Result =
  | { ok: true; command: AppCommand }
  | { ok: false; code: string; message: string };

function fail(message: string): Result {
  return { ok: false, code: "E_INVALID_PAYLOAD", message };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Truncate to TEXT_MAX on a byte boundary. Slicing a string by characters
 * can split a multi-byte sequence, and the robot decodes the payload as
 * UTF-8, so a naive `.slice(0, 240)` can produce invalid text.
 */
export function clampText(text: string, max = TEXT_MAX): string {
  const trimmed = text.trim();
  const bytes = new TextEncoder().encode(trimmed);
  if (bytes.length <= max) return trimmed;
  return new TextDecoder().decode(bytes.slice(0, max));
}

export function validateAppCommand(raw: unknown): Result {
  if (!isObject(raw)) return fail("command must be an object");
  const name = raw.name;
  if (typeof name !== "string") return fail("command name is required");

  switch (name) {
    case "hello":
    case "ping":
    case "bye":
    case "turn_around":
    case "read_sensor":
      return { ok: true, command: { name } as AppCommand };

    case "stop":
      return { ok: true, command: { name: "stop" } };

    case "drive": {
      const cmd = raw.command;
      // A release is expressed as `stop`, not as a direction with held:false.
      // The robot's STOP is a single unambiguous command and is always safe to
      // send, so there is no reason to model release as a second drive frame.
      if (cmd === CMD.STOP) return { ok: true, command: { name: "stop" } };
      if (typeof cmd !== "number" || !DIRECTION_COMMANDS.has(cmd)) {
        return fail(`'${String(cmd)}' is not a direction command`);
      }
      if (typeof raw.held !== "boolean") return fail("held must be a boolean");
      return { ok: true, command: { name: "drive", command: cmd as CommandId, held: raw.held } };
    }

    case "simple": {
      const cmd = raw.command;
      if (typeof cmd !== "number" || !SIMPLE_ALLOWED.has(cmd)) {
        return fail(`'${commandName(Number(cmd))}' cannot be sent as a simple command`);
      }
      return { ok: true, command: { name: "simple", command: cmd as CommandId } };
    }

    case "expression": {
      const cmd = raw.command;
      if (typeof cmd !== "number" || !EXPRESSION_ALLOWED.has(cmd)) {
        return fail(`'${commandName(Number(cmd))}' is not an expression command`);
      }
      return { ok: true, command: { name: "expression", command: cmd as CommandId } };
    }

    case "move_steps": {
      const n = Number(raw.steps);
      if (!Number.isFinite(n)) return fail("steps must be a number");
      // Clamped rather than rejected: the operator asked for a distance, and
      // giving the nearest legal one is friendlier than an error.
      return { ok: true, command: { name: "move_steps", steps: clampArg(n, 1, MAX_STEPS) } };
    }

    case "turn_degrees": {
      const d = Number(raw.degrees);
      if (!Number.isFinite(d)) return fail("degrees must be a number");
      return { ok: true, command: { name: "turn_degrees", degrees: clampArg(d, 1, MAX_TURN_DEGREES) } };
    }

    case "autonomous": {
      if (typeof raw.enabled !== "boolean") return fail("enabled must be a boolean");
      return { ok: true, command: { name: "autonomous", enabled: raw.enabled } };
    }

    case "ask":
    case "speak": {
      if (typeof raw.text !== "string" || !raw.text.trim()) return fail("text is required");
      return { ok: true, command: { name, text: clampText(raw.text) } as AppCommand };
    }

    default:
      return { ok: false, code: "E_UNKNOWN_COMMAND", message: `unknown command '${name}'` };
  }
}

/** True when the id is one the firmware defines a command name for. */
export function isKnownCommand(cmd: number): boolean {
  return commandName(cmd) !== "?";
}
