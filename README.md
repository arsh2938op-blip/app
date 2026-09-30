# WALL-E — Companion App

Control centre for the WALL-E Innovation Day robot: an ESP32-S3 with a
distance sensor, OLED, motors, speaker and its own Gemini pipeline.

The app is a **second controller**. It speaks the same 10-byte binary packets
as the handheld radio remote, over TCP instead of ESP-NOW, and the robot
funnels both through one dispatcher.

> **This repository is the APP only.** The firmware lives in a separate
> repository and is not modified from here. The two meet through a documented
> contract: **[WALL-E Robot API](docs/WALL-E_ROBOT_API.md)**.

---

## Quick start

```bash
npm install

npm run dev:server   # companion server, port 8787
npm run dev:client   # UI, port 5173
```

Open <http://localhost:5173>, then press **Demo mode** to drive a simulated
robot with no hardware.

### Against the real robot

1. The robot's IP is **printed on its serial log at boot**. There is no
   discovery — the firmware has no mDNS.
2. Laptop and robot on the same Wi-Fi.
3. **Connect** tab → enter the IP → **Connect**.

The address is remembered, so a demo needs it typed once.

---

## Android

```bash
npm run android:apk
```

Produces `android/app/build/outputs/apk/debug/app-debug.apk`. Install with
`adb install -d <path>`, or copy the file to the phone and open it (enable
*install from unknown sources*).

The phone still needs the companion server running on the laptop — the app is
a web UI in a native shell, and the server is what speaks TCP to the robot.
To use the phone on its own, run the server on something always-on and point
the app at it.

**See [docs/ANDROID.md](docs/ANDROID.md)** for the toolchain setup, cleartext
networking, and release signing.

---

## Architecture

```
src/
  shared/
    walleProtocol.ts     byte-exact mirror of shared/walle_protocol.h
    walleTypes.ts        app-side JSON types and normalised robot state
    validateAppCommand.ts  allowlist + clamping for every outbound command
  server/
    index.ts
    appServer.ts         broker: HTTP, app WebSocket, command routing
    config.ts
    connection/
      robotLink.ts       TCP to the ESP32: framing, keepalive, reconnect
    storage/
      settingsStore.ts   remembers the robot's IP
  client/
    App.tsx              drive / connect / settings
    store.ts             app socket, state, commands
    keepAwake.ts         screen wake lock (a safety requirement)
    ui/
      Joystick.tsx       8-way virtual joystick
      controls.tsx       drive, timed moves, modes, expressions, voice
      chat.tsx           ask WALL-E, activity feed
      settings.tsx       robot status, connection, settings
  mock/
    mockRobot.ts         simulator speaking the real protocol over real TCP
tests/                   132 tests
```

### Why a server in the middle

A browser cannot open a raw TCP socket, and the robot speaks binary over TCP.
So the server does the framing, and the UI speaks ordinary JSON over a
WebSocket. It is also the only place that can hold the 700 ms safety watchdog
consistently, and one validation chokepoint for everything reaching the robot.

---

## Controls

**Joystick — 8-way, digital.** Push forward to drive, sideways to arc, back to
reverse, hard left/right to pivot. Pressing a direction arms the keepalive;
lifting sends `STOP` immediately. There is no analogue speed: the robot's
contract is a set of intents, and on stage a predictable direction beats a
half-press.

**Timed moves** — `move_steps`, `turn_degrees` and `turn_around` finish by
themselves, so no keepalive and no stop afterwards.

**Ask** — type a question. The robot's own Gemini answers and speaks out loud;
the answer comes back as a text frame. There is no microphone: the robot has
none, and the app adds none.

**Demo mode** — a real TCP simulator running the real protocol, so a green
demo also exercises the real integration. Always labelled.

---

## Safety

These are the robot's rules, surfaced rather than bypassed:

- The robot stops itself if the app goes quiet for **700 ms** while driving.
  The app re-sends the held command every 250 ms and holds a screen wake lock,
  because a locked screen is a silent app.
- A cliff or a dead sensor **stops the robot and is not retried**. The status
  panel shows the ground distance in centimetres.
- WALL-E **will not move while thinking or speaking**. The app shows why
  instead of retrying.
- The handheld remote and the app can never both own the wheels.
- Every outbound command is allowlisted and every argument clamped before it
  is forwarded.

---

## Testing

```bash
npm test        # 132 tests
npm run build   # typecheck + bundle
```

| Area | Covered in |
|---|---|
| Every protocol constant vs the firmware header | `walleProtocol.test.ts` |
| Packet encode/decode, text frames, stream framing, garbage recovery | `walleProtocol.test.ts` |
| Command validation and clamping | `walleProtocol.test.ts` |
| Real TCP against the simulator: drive, stop, keepalive, watchdog, cliff, voice | `robotLink.test.ts` |
| Hostile stream: resync, bad magic, inbound command frames, 64 KB chunk, byte-by-byte text | `robotLink.test.ts` |
| Server end-to-end in demo mode | `appServer.test.ts` |
| Joystick dead zone, 8-way resolution, command mapping | `joystick.test.ts` |

---

## Configuration

Copy `.env.example` to `.env`. Everything is optional.

| Variable | Default | |
|---|---|---|
| `PORT` | `8787` | companion server port |
| `WALLE_ROBOT_HOST` | — | connect to this robot on startup |
| `WALLE_ROBOT_PORT` | `8080` | must match `APP_TCP_PORT` |
| `WALLE_DEMO` | `0` | start in demo mode |
| `WALLE_RECONNECT` | `1` | retry with backoff |
| `WALLE_APP_TOKEN` | random per boot | app WebSocket token |

Settings edited in the UI persist to `.walle/settings.json`.

There is **no API key anywhere**. The robot holds its own Gemini key and runs
its own speech pipeline; the app only sends `ask` and displays the answer.

---

## Remaining hardware-dependent work

Blocked on the physical robot, not on the app:

- **End-to-end validation.** The protocol is verified against a simulator that
  implements the same header, not against silicon.
- **Sensor poll rate.** The app defaults to 5 Hz, the integration doc's
  ceiling. On the real ultrasonic sensor this may need to be slower.
- **Step distance.** `STEP_DISTANCE_CM` is a config constant; with no wheel
  encoders, "4 steps" is a timed estimate until it is measured.
- **Drive feel.** Motor speed, turn duration (`MANEUVER_MS_PER_TURN_360`) and
  PID are firmware-side. The app sends intents only and cannot compensate.
- **The 700 ms watchdog on a bad network.** 250 ms re-sends have margin, but a
  genuinely congested Wi-Fi is untested.
