/**
 * Driving controls: the joystick plus the timed-motion and safety buttons.
 */

import { useState } from "react";
import {
  CMD,
  MAX_STEPS,
  MAX_TURN_DEGREES,
  estimateStepDistanceCm,
  type CommandId,
} from "../../shared/walleProtocol.js";
import {
  dance,
  driveEnd,
  driveStart,
  emergencyStop,
  explore,
  joke,
  moveSteps,
  readSensor,
  setAutonomous,
  setExpression,
  setIdle,
  talk,
  turnAround,
  turnDegrees,
  useStore,
} from "../store.js";
import { Joystick, type StickDirection } from "./Joystick.js";

const EXPRESSIONS = [
  { label: "Happy", command: CMD.EXPR_HAPPY, emoji: "😄" },
  { label: "Confused", command: CMD.EXPR_CONFUSED, emoji: "😕" },
  { label: "Surprised", command: CMD.EXPR_SURPRISED, emoji: "😲" },
  { label: "Thinking", command: CMD.EXPR_THINKING, emoji: "🤔" },
  { label: "Idle", command: CMD.EXPR_IDLE, emoji: "😌" },
] as const;

export function DrivePanel() {
  const connected = useStore((s) => s.connection === "connected");
  const blocked = useStore((s) => s.blocked);
  const driving = useStore((s) => s.driving);
  const [dir, setDir] = useState<StickDirection | null>(null);

  const hold = (command: CommandId) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (!connected) return;
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      driveStart(command);
    },
    onPointerUp: () => driveEnd(),
    onPointerCancel: () => driveEnd(),
  });

  return (
    <div className="card col-7 drive-card">
      <h2>Drive</h2>

      {blocked ? (
        <div className="notice warn" role="status">
          {blocked}
        </div>
      ) : null}

      <div className="drive-layout">
        <div className="joystick-column">
          <Joystick disabled={!connected} onDirection={setDir} />
        </div>

        <div className="drive-side">
          <button className="stop" disabled={!connected} onClick={emergencyStop}>
            STOP
          </button>
          <p className="hint">
            {blocked
              ? "WALL-E will not move while it is talking or near an edge."
              : driving || dir
                ? `Driving — ${dir ?? "forward"}`
                : "Push the stick to drive. Lift to stop."}
          </p>

          <div className="mini-row">
            <span className="mini-label">Quick turn</span>
            <div className="btn-row">
              <button disabled={!connected} {...hold(CMD.ROTATE_LEFT)}>
                ↺ Left
              </button>
              <button disabled={!connected} {...hold(CMD.ROTATE_RIGHT)}>
                ↻ Right
              </button>
            </div>
          </div>

          <div className="mini-row">
            <span className="mini-label">Straight ahead</span>
            <div className="btn-row">
              <button disabled={!connected} {...hold(CMD.MOVE_FORWARD)}>
                ▲ Forward
              </button>
              <button disabled={!connected} {...hold(CMD.MOVE_BACKWARD)}>
                ▼ Back
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Timed motions. These finish by themselves, so there is no keepalive and no
 * stop afterwards — the robot is doing the timing, not the operator.
 */
export function TimedMotionPanel() {
  const connected = useStore((s) => s.connection === "connected");
  const steps = useStore((s) => s.settings?.stepCount ?? 4);
  const [degrees, setDegrees] = useState(90);
  const [sent, setSent] = useState<string | null>(null);

  const flash = (msg: string) => {
    setSent(msg);
    window.setTimeout(() => setSent(null), 2500);
  };

  return (
    <div className="card col-5">
      <h2>Timed moves</h2>
      <p className="hint">These stop by themselves. No keepalive needed.</p>

      <div className="form-row">
        <label htmlFor="steps">Steps ({estimateStepDistanceCm(steps)} cm)</label>
        <input
          id="steps"
          type="range"
          min={1}
          max={MAX_STEPS}
          step={1}
          value={steps}
          disabled={!connected}
          onChange={(e) => {
            const v = Number(e.target.value);
            void fetch("/api/settings", {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ stepCount: v }),
            });
          }}
        />
      </div>
      <div className="btn-row">
        <button
          disabled={!connected}
          onClick={() => {
            moveSteps(steps);
            flash(`Driving ${steps} steps`);
          }}
        >
          Move {steps} steps
        </button>
        <button
          disabled={!connected}
          onClick={() => {
            turnAround();
            flash("Turning around");
          }}
        >
          ↻ Turn around
        </button>
      </div>

      <div className="form-row" style={{ marginTop: 12 }}>
        <label htmlFor="deg">Turn — {degrees}°</label>
        <input
          id="deg"
          type="range"
          min={1}
          max={MAX_TURN_DEGREES}
          step={5}
          value={degrees}
          disabled={!connected}
          onChange={(e) => setDegrees(Number(e.target.value))}
        />
      </div>
      <button
        disabled={!connected}
        onClick={() => {
          turnDegrees(degrees);
          flash(`Turning ${degrees}°`);
        }}
      >
        Turn {degrees}°
      </button>

      {sent ? <p className="hint ok">{sent}</p> : null}
    </div>
  );
}

export function ExpressionPanel() {
  const connected = useStore((s) => s.connection === "connected");
  return (
    <div className="card col-4">
      <h2>Expression</h2>
      <div className="expressions">
        {EXPRESSIONS.map((e) => (
          <button
            key={e.label}
            disabled={!connected}
            onClick={() => setExpression(e.command)}
          >
            <span aria-hidden>{e.emoji}</span>
            <br />
            {e.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ModesPanel() {
  const connected = useStore((s) => s.connection === "connected");
  const status = useStore((s) => s.status);
  const [dancing, setDancing] = useState(false);
  const [exploring, setExploring] = useState(false);

  const state = status?.state;
  const autonomous = state === "exploring";

  return (
    <div className="card col-4">
      <h2>Modes</h2>
      <div className="modes">
        <button
          className="primary"
          disabled={!connected || dancing}
          onClick={() => {
            setDancing(true);
            dance();
          }}
        >
          {dancing ? "Dancing…" : "Dance"}
        </button>
        <button
          disabled={!connected || exploring}
          onClick={() => {
            setExploring(true);
            explore();
          }}
        >
          {exploring ? "Exploring…" : "Explore"}
        </button>
        <button disabled={!connected} onClick={setIdle}>
          Idle
        </button>

        <div className="switch-row">
          <div>
            <strong>Autonomous</strong>
            <div className="hint">WALL-E decides its own movements</div>
          </div>
          <button
            className="switch"
            role="switch"
            aria-checked={autonomous}
            aria-label="Autonomous mode"
            disabled={!connected}
            onClick={() => setAutonomous(!autonomous)}
          />
        </div>
      </div>
    </div>
  );
}

export function VoiceQuickPanel() {
  const connected = useStore((s) => s.connection === "connected");
  return (
    <div className="card col-4">
      <h2>Say something</h2>
      <p className="hint">WALL-E picks the words and speaks them out loud.</p>
      <div className="btn-row">
        <button disabled={!connected} onClick={talk}>
          Talk to me
        </button>
        <button disabled={!connected} onClick={joke}>
          Tell a joke
        </button>
        <button disabled={!connected} onClick={readSensor}>
          Read sensor
        </button>
      </div>
    </div>
  );
}
