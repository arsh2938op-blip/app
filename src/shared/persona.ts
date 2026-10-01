/**
 * Vulkan — the robot's persona.
 *
 * The personality is enforced on the ROBOT, not here, because the robot owns
 * Gemini and the speaker: the app sends `ask`, the firmware builds the prompt
 * and TTS speaks the result out loud through the amplifier. Anything the app
 * synthesised would be a second voice fighting the real one.
 *
 * So this file is the contract the firmware implements, in one place, with the
 * exact text that gets spoken.
 */

import { TEXT_MAX } from "./walleProtocol.js";

export const ROBOT_NAME = "Vulkan";

export const CREATORS = [
  "Aakansh Abhiraj",
  "Arsh Prit",
  "Mayank Arya",
  "Zulkarnain",
] as const;

/**
 * The system prompt the firmware puts in front of Gemini.
 *
 * Rules, and the reason each one exists:
 *  - always replies, so a child is never left in silence
 *  - always ends with "Friend!", the signature the team asked for
 *  - cheerful and never sad, which is the tone the robot's character is
 *  - short, because TTS on a small robot is slow and the demo is live
 *
 * Deliberately terse. This has to survive the 240-byte text-frame limit
 * alongside the name and the signature, and every word spent here is a word
 * not spent on the rules.
 */
export const PERSONA_PROMPT =
  "You are Vulkan, a friendly robot for kids. Always reply. " +
  "End every reply with Friend!. Be happy and joyful, never sad. " +
  "One or two short sentences, no emoji.";

/**
 * The persona as a compact wire payload.
 *
 * Sent as a TEXT frame after WALLE_CMD_SET_PERSONA, so a build can be told who
 * it is at runtime instead of it being compiled in. JSON because the firmware
 * then has one thing to parse rather than a bespoke string format — but the
 * keys are single characters, because a text frame is 240 bytes and that is
 * the entire budget.
 *
 * The creators are deliberately NOT in this payload. Including all four names
 * pushes it to 297 bytes, and a clipped JSON string would not parse on the
 * robot. They belong in the app UI and in the firmware's own credits line,
 * where Gemini has no need of them.
 *
 * Throws rather than truncating. A silent failure here would surface much
 * later as a robot answering in the wrong voice, which is far harder to
 * diagnose than a build-time error.
 */
export function personaPayload(): string {
  const json = JSON.stringify({
    n: ROBOT_NAME,
    s: "Friend!",
    m: "happy",
    p: PERSONA_PROMPT,
  });

  const bytes = new TextEncoder().encode(json).length;
  if (bytes > TEXT_MAX) {
    throw new Error(
      `persona payload is ${bytes} bytes, over the ${TEXT_MAX}-byte text frame. ` +
        "Shorten PERSONA_PROMPT.",
    );
  }
  return json;
}

/** True when a reply already carries the signature. */
export function hasSignature(text: string): boolean {
  return /friend!\s*$/i.test(text.trim());
}

/**
 * Append the signature if the robot forgot it.
 *
 * Only ever used for the on-screen transcript, never for what is spoken — the
 * robot's audio is the source of truth. A missing "Friend!" on screen would
 * read as a bug during a demo even when the firmware is correct, and quietly
 * repairing the transcript is better than showing the discrepancy live. The
 * reply text is left untouched on the activity feed, so a genuine firmware
 * bug is still visible there.
 */
export function withSignature(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  if (hasSignature(trimmed)) return trimmed;
  return `${trimmed} Friend!`;
}