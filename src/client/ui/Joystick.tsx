/**
 * Virtual joystick.
 *
 * Digital, 8-way: the dominant axis wins, so a diagonal resolves to a single
 * command. This matches how the tracked robot actually moves and keeps the
 * behaviour predictable on stage, where a half-pressed analogue axis would
 * be hard to read at a glance.
 *
 *   forward          -> MOVE_FORWARD
 *   forward + left   -> TURN_LEFT   (arc)
 *   forward + right  -> TURN_RIGHT  (arc)
 *   down + left      -> TURN_LEFT   (reverse arc)
 *   backward         -> MOVE_BACKWARD
 *   left / right     -> ROTATE_LEFT / ROTATE_RIGHT
 *   centre           -> STOP
 *
 * The stick arms the robot's keepalive on press and sends STOP on release, so
 * lifting a finger is always enough to stop.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CMD, type CommandId } from "../../shared/walleProtocol.js";
import { driveEnd, driveStart } from "../store.js";

/** Dead zone as a fraction of the stick radius. */
const DEAD_ZONE = 0.28;

export type StickDirection =
  | "forward"
  | "backward"
  | "left"
  | "right"
  | "forward_left"
  | "forward_right"
  | "backward_left"
  | "backward_right";

export interface JoystickProps {
  disabled?: boolean;
  size?: number;
  /** Called with the resolved direction, or null when the stick is centred. */
  onDirection?: (dir: StickDirection | null) => void;
  label?: string;
}

/**
 * Resolve a stick position to a direction.
 *
 * Exported so the mapping can be unit tested without touching the DOM — this
 * is the logic that decides which wheels move, and it deserves a test.
 */
export function resolveDirection(
  x: number,
  y: number,
  radius: number,
): StickDirection | null {
  const dist = Math.hypot(x, y);
  if (dist < DEAD_ZONE * radius) return null;

  // Screen y grows downward, so the robot's forward is -y. Measuring the
  // angle from straight up and dividing into eight 45-degree sectors gives
  // a true 8-way stick: every direction, including pure left and right
  // rotation, is reachable rather than only in a narrow band.
  const angle = Math.atan2(x, -y); // 0 = up, +PI/2 = right
  const sector = Math.round(angle / (Math.PI / 4));
  const idx = ((sector % 8) + 8) % 8;

  return SECTORS[idx]!;
}

/** Clockwise from straight up. Index is `sector` mod 8. */
const SECTORS: readonly StickDirection[] = [
  "forward",
  "forward_right",
  "right",
  "backward_right",
  "backward",
  "backward_left",
  "left",
  "forward_left",
];

/** The command a direction maps to, or null for the dead zone. */
export function directionToCommand(dir: StickDirection | null): number | null {
  switch (dir) {
    case "forward":
      return CMD.MOVE_FORWARD;
    case "backward":
      return CMD.MOVE_BACKWARD;
    case "forward_left":
    case "backward_left":
      return CMD.TURN_LEFT;
    case "forward_right":
    case "backward_right":
      return CMD.TURN_RIGHT;
    case "left":
      return CMD.ROTATE_LEFT;
    case "right":
      return CMD.ROTATE_RIGHT;
    case null:
    default:
      return null;
  }
}

const DIR_LABEL: Record<StickDirection, string> = {
  forward: "Forward",
  backward: "Backward",
  left: "Rotate left",
  right: "Rotate right",
  forward_left: "Arc left",
  forward_right: "Arc right",
  backward_left: "Reverse arc left",
  backward_right: "Reverse arc right",
};

export function Joystick({ disabled, size = 180, onDirection, label = "Drive WALL-E" }: JoystickProps) {
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const [active, setActive] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const pointerId = useRef<number | null>(null);
  const currentCmd = useRef<number | null>(null);

  const radius = size / 2 - 18;

  const stop = useCallback(() => {
    if (currentCmd.current !== null) {
      driveEnd();
      currentCmd.current = null;
    }
  }, []);

  const move = useCallback(
    (clientX: number, clientY: number) => {
      const el = surfaceRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = clientX - (rect.left + rect.width / 2);
      const y = clientY - (rect.top + rect.height / 2);
      const dist = Math.hypot(x, y);
      const clamped = dist > radius ? { x: (x / dist) * radius, y: (y / dist) * radius } : { x, y };

      setKnob(clamped);
      const dir = resolveDirection(clamped.x, clamped.y, radius);
      onDirection?.(dir);

      const cmd = directionToCommand(dir);
      if (cmd !== currentCmd.current) {
        // Changing direction: release the old one first so the robot never
        // receives two conflicting drive commands.
        if (currentCmd.current !== null) driveEnd();
        if (cmd !== null) {
          driveStart(cmd as CommandId);
          currentCmd.current = cmd;
        } else {
          currentCmd.current = null;
        }
      }
    },
    [radius, onDirection],
  );

  const release = useCallback(() => {
    setKnob({ x: 0, y: 0 });
    setActive(false);
    onDirection?.(null);
    stop();
  }, [onDirection, stop]);

  // A drag that ends outside the surface must still stop the robot.
  useEffect(() => {
    const onUp = () => release();
    const onCancel = () => release();
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [release]);

  // Losing focus mid-drive (tab switch, notification) must not leave the
  // robot running.
  useEffect(() => {
    const onHide = () => {
      if (document.hidden) release();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("blur", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("blur", onHide);
    };
  }, [release]);

  const dir = resolveDirection(knob.x, knob.y, radius);

  return (
    <div className="joystick-wrap">
      <div
        ref={surfaceRef}
        className={`joystick ${active ? "active" : ""} ${disabled ? "disabled" : ""}`}
        style={{ width: size, height: size }}
        role="application"
        aria-label={label}
        onPointerDown={(e) => {
          if (disabled) return;
          e.preventDefault();
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          pointerId.current = e.pointerId;
          setActive(true);
          move(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (disabled || !active) return;
          move(e.clientX, e.clientY);
        }}
        onPointerUp={release}
        onPointerCancel={release}
      >
        <div className="joystick-cross" aria-hidden>
          <span className="up">▲</span>
          <span className="left">◀</span>
          <span className="right">▶</span>
          <span className="down">▼</span>
        </div>
        <div
          className="joystick-knob"
          style={{
            width: size * 0.42,
            height: size * 0.42,
            transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))`,
          }}
        />
      </div>
      <div className="joystick-readout">
        {disabled ? "Not connected" : dir ? DIR_LABEL[dir] : "Idle — push to drive"}
      </div>
    </div>
  );
}
