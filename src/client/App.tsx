import { useEffect, useState } from "react";
import {
  api,
  connectDirect,
  loadSettings,
  startDirectLink,
  useStore,
} from "./store.js";
import { linkModeLabel } from "./nativeLink.js";
import { useToast } from "./ui/common.js";
import { acquireWakeLock } from "./keepAwake.js";
import { ConnectionPanel, RobotInfoPanel, SettingsPanel } from "./ui/settings.js";
import {
  DrivePanel,
  ExpressionPanel,
  ModesPanel,
  TimedMotionPanel,
  VoiceQuickPanel,
} from "./ui/controls.js";
import { ActivityPanel, ChatPanel } from "./chat.js";
import { ROBOT_NAME, CREATORS } from "../shared/persona.js";
import { ROBOT_STATE } from "../shared/walleProtocol.js";

type Tab = "drive" | "connect" | "settings";

const CONNECTION_LABEL: Record<string, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  error: "Error",
};

/** Short label for the robot's current state, as the firmware names it. */
function stateLabel(code: number, name: string): string {
  if (code === ROBOT_STATE.THINKING) return "Thinking…";
  if (code === ROBOT_STATE.SPEAKING) return "Speaking…";
  if (code === ROBOT_STATE.REMOTE) return "Driving";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function App() {
  const connection = useStore((s) => s.connection);
  const demoMode = useStore((s) => s.demoMode);
  const status = useStore((s) => s.status);
  const target = useStore((s) => s.target);
  const lastError = useStore((s) => s.lastError);
  const [tab, setTab] = useState<Tab>("drive");
  const [toast, notify] = useToast();

  // Settings are needed by the step-count slider on first render.
  useEffect(() => {
    void loadSettings();
  }, []);

  /**
   * On the phone, open a raw TCP socket to the robot itself. This is what
   * makes the app work with no laptop and no companion server.
   */
  useEffect(() => {
    if (!startDirectLink()) return;
    void api
      .settings()
      .then((s) => {
        if (s.host) connectDirect(s.host, s.port);
        else notify("Enter the robot's IP on the Connect tab", "err");
      })
      .catch(() => notify("Enter the robot's IP on the Connect tab", "err"));
  }, [notify]);

  // A locked screen would make the app go quiet and the robot would stop
  // itself mid-manoeuvre, so keep the display awake while this is visible.
  useEffect(() => {
    void acquireWakeLock();
  }, []);

  const offline = connection !== "connected";
  const state = status?.state ?? "boot";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="logo" aria-hidden>
            ▣
          </div>
          <div>
            <h1>{ROBOT_NAME}</h1>
            <div className="hint">
              {target ? `${target.host}:${target.port}` : "no robot"} ·{" "}
              {linkModeLabel()}
            </div>
          </div>
        </div>

        <div className="conn">
          <span className={`dot ${connection}`} />
          <span>
            {demoMode && offline ? "Demo — " : ""}
            {CONNECTION_LABEL[connection] ?? connection}
          </span>
        </div>

        <div className={`pill state-pill ${state}`}>{stateLabel(status?.stateCode ?? 0, state)}</div>

        <nav className="tabs" role="tablist">
          {(["drive", "connect", "settings"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={tab === t ? "selected" : ""}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
      </header>

      {demoMode ? <div className="demo-banner">DEMO MODE — simulated robot, no hardware</div> : null}

      {/* Credits belong on screen at an Innovation Day, not buried in a README. */}
      <div className="credits">
        <strong>{ROBOT_NAME}</strong> · by {CREATORS.join(", ")}
      </div>

      {offline && lastError ? (
        <div className="demo-banner offline">
          WALL-E offline — {lastError.message}
          {tab !== "connect" ? (
            <button className="ghost" style={{ marginLeft: 10 }} onClick={() => setTab("connect")}>
              Connect
            </button>
          ) : null}
        </div>
      ) : null}

      {tab === "drive" ? (
        <main className="grid">
          <DrivePanel />
          <TimedMotionPanel />
          <RobotInfoPanel />
          <ModesPanel />
          <ExpressionPanel />
          <VoiceQuickPanel />
          <ChatPanel />
          <ActivityPanel />
        </main>
      ) : null}

      {tab === "connect" ? (
        <main className="grid">
          <ConnectionPanel notify={notify} />
          <RobotInfoPanel />
        </main>
      ) : null}

      {tab === "settings" ? (
        <main className="grid">
          <SettingsPanel notify={notify} />
          <RobotInfoPanel />
        </main>
      ) : null}

      {toast ? <div className={`toast ${toast.kind}`}>{toast.msg}</div> : null}
    </div>
  );
}
