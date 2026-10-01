import { useEffect, useRef, useState } from "react";
import { ask, speak, useStore } from "./store.js";
import { speech, type SpeechState } from "./speech.js";
import { ROBOT_NAME } from "../shared/persona.js";
import { timeOf } from "./ui/common.js";
import type { ActivityEntry } from "../shared/walleTypes.js";

/**
 * Talk to Vulkan.
 *
 * Speech in comes from the phone's microphone, because the robot has none.
 * Speech out is the robot's own: it answers with its Gemini key and speaks
 * through its amplifier, and the app only displays the text that comes back.
 * The app never synthesises audio of its own — a second voice would fight the
 * real one, and the robot's speaker is the thing a demo is meant to show.
 */
export function ChatPanel() {
  const connected = useStore((s) => s.connection === "connected");
  const chat = useStore((s) => s.chat);
  const blocked = useStore((s) => s.blocked);
  const state = useStore((s) => s.status?.state);
  const [text, setText] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [speechState, setSpeechState] = useState<SpeechState>(speech.getState());
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => speech.subscribe(setSpeechState), []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat.length]);

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    ask(value);
    setHistory((h) => [value, ...h].filter((v, i, a) => a.indexOf(v) === i).slice(0, 6));
    setText("");
  };

  /** Listen, then send whatever came back as a normal question. */
  const talk = async () => {
    const result = await speech.listen();
    if (result?.text) {
      const heard = result.text;
      ask(heard);
      setHistory((h) => [heard, ...h].filter((v, i, a) => a.indexOf(v) === i).slice(0, 6));
    }
  };

  const speaking = state === "speaking";
  const thinking = state === "thinking";
  const micBusy = !connected || speaking || thinking || speechState.listening;
  const micSupported = speechState.availability === "ready";

  return (
    <div className="card col-7">
      <h2>Talk to {ROBOT_NAME}</h2>

      <div className="chat">
        {chat.length === 0 ? (
          <div className="bubble system">
            Ask {ROBOT_NAME} something, or press the mic and say it out loud. It answers in
            its own voice and speaks through the robot&apos;s speaker.
          </div>
        ) : (
          chat.map((m) => (
            <div key={m.id} className={`bubble ${m.from}`}>
              {m.text}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>

      <div className="composer">
        <input
          value={text}
          placeholder={connected ? `Ask ${ROBOT_NAME} something…` : "Not connected"}
          disabled={!connected}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <button className="primary" disabled={!connected || !text.trim()} onClick={submit}>
          Ask
        </button>
        <button
          className={speechState.listening ? "mic live" : "mic"}
          disabled={micBusy || !micSupported}
          onClick={talk}
          title={
            micSupported
              ? "Speak to the robot"
              : speechUnavailableReason(speechState.availability)
          }
          aria-label="Speak to the robot"
        >
          {speechState.listening ? "●" : "🎤"}
        </button>
        <button
          disabled={!connected || !text.trim() || speaking}
          title="Say this exact line, no AI"
          onClick={() => {
            speak(text.trim());
            setText("");
          }}
        >
          Say
        </button>
      </div>

      {/* Where the answer actually comes from. During a demo this is the
          difference between "the app is broken" and "the robot is speaking". */}
      <div className={`speech-status${speaking ? " live" : ""}`}>
        {speaking ? (
          <>
            <span className="eq" aria-hidden>
                <i />
                <i />
                <i />
              </span>
            Speaking through the robot&apos;s speaker
          </>
        ) : thinking ? (
          "Thinking…"
        ) : speechState.listening ? (
          speechState.interim || "Listening…"
        ) : speechState.error ? (
          speechState.error
        ) : null}
      </div>

      {blocked ? <p className="hint warn">{blocked}</p> : null}

      {history.length > 0 ? (
        <div className="btn-row" style={{ marginTop: 8 }}>
          {history.slice(0, 3).map((h) => (
            <button key={h} className="ghost" onClick={() => setText(h)}>
              {h}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function speechUnavailableReason(availability: SpeechState["availability"]): string {
  switch (availability) {
    case "no-mic-permission":
      return "Microphone permission denied — allow it in Settings";
    case "no-mic":
      return "Speech input needs Google's speech service on this device";
    default:
      return "Speech input is not available here — type instead";
  }
}

/**
 * Compact event log.
 *
 * The robot re-sends its state about once a second as a keepalive floor, and
 * the integration doc explicitly warns against treating each one as a screen
 * update, so consecutive duplicates are collapsed into a single line.
 */
export function ActivityPanel() {
  const activity = useStore((s) => s.activity);
  const [showDebug, setShowDebug] = useState(false);

  const filtered = activity.filter((a) => showDebug || a.level !== "debug");

  const collapsed: (ActivityEntry & { count: number })[] = [];
  for (const entry of filtered) {
    const last = collapsed[collapsed.length - 1];
    if (last && last.label === entry.label && entry.at - last.at < 3000) {
      last.count += 1;
      continue;
    }
    collapsed.push({ ...entry, count: 1 });
  }

  return (
    <div className="card col-5">
      <h2>
        Activity
        <button
          className="ghost"
          style={{ float: "right", padding: "2px 8px", fontSize: 12 }}
          onClick={() => setShowDebug((v) => !v)}
        >
          {showDebug ? "hide low-level" : "show low-level"}
        </button>
      </h2>
      <div className="activity">
        {collapsed.length === 0 ? (
          <div className="hint">No activity yet.</div>
        ) : (
          collapsed.slice(0, 120).map((a) => (
            <div key={a.id} className={`activity-row ${a.level ?? "info"}`}>
              <span className="t">{timeOf(a.at)}</span>
              <span className="k">{a.kind}</span>
              <span className="l">{a.label}</span>
              {a.detail ? <span className="d">{a.detail}</span> : null}
              {a.count > 1 ? <span className="d">x{a.count}</span> : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}