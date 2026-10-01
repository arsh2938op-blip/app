import { useEffect, useState } from "react";
import { DEFAULT_ROBOT_PORT, ROBOT_STATE } from "../../shared/walleProtocol.js";
import { ROBOT_NAME } from "../../shared/persona.js";
import {
  api,
  connectDirect,
  disconnectDirect,
  isDirectLink,
  readSensor,
  useStore,
} from "../store.js";
import { linkModeLabel } from "../nativeLink.js";
import { timeOf } from "./common.js";

const CONNECTION_LABEL: Record<string, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  error: "Error",
};

/**
 * Robot status.
 *
 * Everything here is derived from binary status frames. The battery row only
 * appears if the robot ever reports a real reading, because the current
 * firmware has no battery sensor and a fake gauge would be worse than none.
 */
export function RobotInfoPanel() {
  const status = useStore((s) => s.status);
  const target = useStore((s) => s.target);
  const connection = useStore((s) => s.connection);
  const demoMode = useStore((s) => s.demoMode);
  const name = useStore((s) => s.robotName);
  const driving = useStore((s) => s.driving);

  const cliff = status?.cliffName ?? "unknown";
  const cliffClass =
    cliff === "ground" ? "ok" : cliff === "warn" ? "warn" : cliff === "unknown" ? "" : "err";

  const rows: [string, React.ReactNode][] = [
    ["Robot", name],
    ["Link", CONNECTION_LABEL[connection] ?? connection],
    ["IP", target ? `${target.host}:${target.port}` : "—"],
    ["State", status?.state ?? "—"],
    [
      "Wheels",
      status?.wheelsBlocked
        ? "Locked — talking"
        : driving
          ? "App is driving"
          : status?.remoteHasControl
            ? "Radio remote"
            : "Free",
    ],
    ["Mode", status?.autonomous ? "Autonomous" : "Manual"],
    ["Floor", `${cliff} · ${status?.groundCm ?? 0} cm`],
    ["Radio remote", status?.remoteState ?? "—"],
    ...(status?.batteryMillivolts
      ? ([["Battery", `${(status.batteryMillivolts / 1000).toFixed(2)} V`]] as [
          string,
          React.ReactNode,
        ][])
      : []),
  ];

  return (
    <div className="card col-4">
      <h2>Robot</h2>

      {status?.wheelsBlocked ? (
        <div className="notice warn">
           is {status.state}. It will not move while it is thinking or speaking.
        </div>
      ) : null}
      {cliff === "drop" || cliff === "fault" ? (
        <div className="notice err">
          {cliff === "drop"
            ? "No floor detected — the robot has stopped."
            : "Distance sensor is not responding — the robot has stopped."}
        </div>
      ) : null}
      {demoMode ? null : null}

      {rows.map(([k, v]) => (
        <div className="stat-row" key={k}>
          <span>{k}</span>
          <span className={k === "Floor" ? cliffClass : ""}>{v}</span>
        </div>
      ))}
    </div>
  );
}

export function ConnectionPanel({ notify }: { notify: (m: string, k?: "ok" | "err") => void }) {
  const connection = useStore((s) => s.connection);
  const demoMode = useStore((s) => s.demoMode);
  const target = useStore((s) => s.target);
  const status = useStore((s) => s.status);
  const direct = isDirectLink();
  const [host, setHost] = useState("");
  const [port, setPort] = useState(DEFAULT_ROBOT_PORT);

  useEffect(() => {
    void api
      .settings()
      .then((s) => {
        if (s.host) setHost(s.host);
        setPort(s.port);
      })
      .catch(() => {});
  }, []);

  const connect = async () => {
    if (!host.trim()) return notify("Enter the IP from the robot's serial log", "err");
    const p = Number(port) || DEFAULT_ROBOT_PORT;
    // On the phone there is no companion server to ask, so the socket is
    // opened here and the address is only remembered for next launch.
    if (direct) {
      connectDirect(host.trim(), p);
      void api.saveSettings({ host: host.trim(), port: p }).catch(() => {});
      notify("Connecting straight to the robot…");
      return;
    }
    try {
      await api.connect(host.trim(), p);
      notify("Connecting…");
    } catch (err) {
      notify((err as Error).message, "err");
    }
  };

  const toggleDemo = async () => {
    // Demo mode is the companion server's simulator; there is nothing to
    // simulate from on a phone that is talking to the robot directly.
    if (direct) return notify("Demo mode is for the desktop server");
    try {
      const { demoMode: now } = await api.demo(!demoMode);
      notify(now ? "Demo mode ON — simulated robot" : "Demo mode OFF");
    } catch (err) {
      notify((err as Error).message, "err");
    }
  };

  return (
    <div className="card col-8">
      <h2>Connection</h2>

      <div className="notice">
        {ROBOT_NAME} does not broadcast on the network. Its IP address is printed on the
        serial log at boot. Type it once and the app remembers it.
      </div>
      <div className="notice">
        Link: <strong>{linkModeLabel()}</strong>
        {direct
          ? " — this phone opens the socket itself, so no computer needs to be running."
          : " — a companion server on your computer carries the robot's TCP traffic."}
      </div>

      <div className="form-grid">
        <div className="form-row">
          <label htmlFor="ip">IP address</label>
          <input
            id="ip"
            value={host}
            placeholder="192.168.1.42"
            inputMode="decimal"
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => setHost(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && connect()}
          />
        </div>
        <div className="form-row">
          <label htmlFor="port">Port</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              id="port"
              type="number"
              inputMode="numeric"
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
            />
            <button className="primary" onClick={connect}>
              Connect
            </button>
          </div>
        </div>
      </div>

      <div className="btn-row">
        <button className={demoMode ? "on" : ""} onClick={toggleDemo}>
          {demoMode ? "Demo mode: ON" : "Demo mode: OFF"}
        </button>
        <button
          className="danger"
          disabled={connection === "disconnected"}
          onClick={() => {
            if (direct) {
              disconnectDirect();
              return;
            }
            void api.disconnect();
          }}
        >
          Disconnect
        </button>
        <button disabled={connection !== "connected"} onClick={readSensor}>
          Read sensor
        </button>
      </div>

      {target ? (
        <p className="hint" style={{ marginBottom: 0 }}>
          Connected over raw TCP to {target.host}:{target.port} · state{" "}
          {status?.state ?? "unknown"} ({status?.stateCode ?? 0})
        </p>
      ) : null}
    </div>
  );
}

export function SettingsPanel({ notify }: { notify: (m: string, k?: "ok" | "err") => void }) {
  const [s, setS] = useState<Awaited<ReturnType<typeof api.settings>> | null>(null);

  useEffect(() => {
    void api.settings().then(setS).catch(() => {});
  }, []);

  if (!s) {
    return (
      <div className="card col-6">
        <h2>Settings</h2>
        <div className="hint">Loading…</div>
      </div>
    );
  }

  const patch = async (next: Partial<typeof s>) => {
    try {
      setS(await api.saveSettings(next));
    } catch (err) {
      notify((err as Error).message, "err");
    }
  };

  return (
    <div className="card col-6">
      <h2>Settings</h2>

      <div className="form-grid">
        <div className="form-row">
          <label htmlFor="name">Robot name</label>
          <input
            id="name"
            defaultValue={s.robotName}
            onBlur={(e) => e.target.value !== s.robotName && void patch({ robotName: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label htmlFor="port2">Robot port</label>
          <input
            id="port2"
            type="number"
            defaultValue={s.port}
            onBlur={(e) => e.target.value !== String(s.port) && void patch({ port: Number(e.target.value) })}
          />
        </div>
      </div>

      <div className="form-row">
        <label htmlFor="poll">
          Sensor poll — {s.sensorPollMs === 0 ? "off" : `${s.sensorPollMs} ms`}
        </label>
        <input
          id="poll"
          type="range"
          min={0}
          max={1000}
          step={100}
          defaultValue={s.sensorPollMs}
          onChange={(e) => void patch({ sensorPollMs: Number(e.target.value) })}
        />
        <span className="hint">
          Each poll is a real ultrasonic echo on the robot. 200 ms is about 5 Hz,
          which is the useful ceiling. 0 disables polling.
        </span>
      </div>

      <div className="switch-row">
        <div>
          <strong>Auto reconnect</strong>
          <div className="hint">Retry with backoff if the robot reboots or Wi-Fi drops</div>
        </div>
        <button
          className="switch"
          role="switch"
          aria-checked={s.autoReconnect}
          aria-label="Auto reconnect"
          onClick={() => void patch({ autoReconnect: !s.autoReconnect })}
        />
      </div>

      <p className="hint" style={{ marginBottom: 0 }}>
        There is no API key on this side. The robot holds its own Gemini key and
        runs its own speech pipeline — the app only sends{" "}
        <code>ask</code> and receives the answer.
      </p>
    </div>
  );
}

export { timeOf, ROBOT_STATE };
