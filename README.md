# WALL-E — Companion App

Control centre for **Vulkan**, the Innovation Day robot: an ESP32-S3 with a
distance sensor, OLED, motors, speaker and its own Gemini pipeline.

**Vulkan** · by Aakansh Abhiraj, Arsh Prit, Mayank Arya, Zulkarnain

The app is a **second controller**. It speaks the same 10-byte binary packets
as the handheld radio remote, over TCP instead of ESP-NOW, and the robot funnels
both through one dispatcher.

> **This repository is the APP only.** The firmware lives in a separate
> repository and is not modified from here. The two meet through a documented
> contract: **[WALL-E Robot API](docs/WALL-E_ROBOT_API.md)**.

---

## Two ways to run

| | |
|---|---|
| **On the phone (no laptop)** | The APK opens a raw TCP socket to the robot itself. Nothing else to start. |
| **In a browser** | A companion server on your computer carries the robot's TCP traffic. Useful for development. |

Both run **the same protocol code**, `src/shared/robotCore.ts`. The on-device
app is not a reimplementation — it is the identical, tested logic with a
different socket underneath.

---

## Installing on a phone

**No Node, no Android Studio, no JDK.** Download the APK from
[Releases](https://github.com/arsh2938op-blip/app/releases), allow the
unknown-source install, and enter the robot's IP.

Full steps in **[docs/INSTALL.md](docs/INSTALL.md)**. The APK is rebuilt and
republished automatically whenever a `v*` tag is pushed.

---

## Quick start

### On a phone

```bash
npm install
npm run android:apk      # -> android/app/build/outputs/apk/debug/app-debug.apk
```

Install it, then **Connect** tab → the robot's IP from its serial log →
**Connect**. That is the whole setup.

### In a browser

```bash
npm run dev:server       # companion server, port 8787
npm run dev:client       # UI, port 5173
```

Press **Demo mode** to drive a simulated robot with no hardware.

---

## The robot has no microphone

So speech input is the phone's job. The mic button runs recognition on-device
through the Web Speech API — no API key, no server, and it works with the
laptop switched off.

Speech **out** is the robot's own. It answers with its Gemini key and speaks
through its amplifier; the app only displays the text that comes back. The app
deliberately has no TTS of its own — a second voice would fight the real one.
A "speaking through the robot's speaker" indicator, driven by the robot's own
state, shows where the sound is coming from.

---

## The persona

Vulkan's personality is enforced on the **robot**, because the robot owns Gemini
and the speaker. The app sends it on connect, as a compact JSON payload, so a
firmware build does not have to have it compiled in:

```json
{"n":"Vulkan","s":"Friend!","m":"happy","p":"You are Vulkan, a friendly robot for kids. ..."}
```

The robot must use `p` as the Gemini system instruction and append `s` to
every reply before TTS. See §11 of the API doc.

If a reply arrives without the signature, the on-screen transcript quietly adds
it — but the activity feed keeps the raw text, so a genuine firmware bug stays
visible rather than being papered over.

---

## Controls

**Joystick — 8-way, digital.** Push forward to drive, sideways to arc, back to
reverse, hard left/right to pivot. Pressing arms the keepalive; lifting sends
`STOP` immediately. There is no analogue speed: the robot's contract is a set
of intents, and on stage a predictable direction beats a half-press.

**Timed moves** — `move_steps`, `turn_degrees` and `turn_around` finish by
themselves, so no keepalive and no stop afterwards.

**Ask / mic** — type or speak. Either way the robot answers in its own voice.

---

## Safety

These are the robot's rules, surfaced rather than bypassed:

- The robot stops itself if the app goes quiet for **700 ms** while driving.
  The app re-sends the held command every 250 ms and holds a screen wake lock,
  because a locked screen is a silent app.
- A cliff or a dead sensor **stops the robot and is not retried**. The status
  panel shows the ground distance in centimetres.
- Vulkan **will not move while thinking or speaking**. The app shows why
  instead of retrying.
- The handheld remote and the app can never both own the wheels.
- Every outbound command is allowlisted and every argument clamped before it
  is forwarded.

---

## Architecture

```
src/
  shared/
    walleProtocol.ts   byte-exact mirror of shared/walle_protocol.h
    robotCore.ts       the protocol + watchdog + safety rules, no socket
    persona.ts         Vulkan's identity, as the firmware must implement it
    walleTypes.ts      app-side JSON types and normalised robot state
    validateAppCommand.ts  allowlist + clamping for every outbound command
  server/
    appServer.ts       broker: HTTP, app WebSocket, command routing
    connection/
      robotLink.ts     net.Socket -> RobotCore (thin adapter)
  client/
    directRobot.ts     RobotCore over the Android TCP plugin (phone)
    nativeLink.ts      base64 bridge to the Kotlin plugin
    store.ts           one API for both paths; picks per platform
    speech.ts          Web Speech API microphone capture
    chat.tsx           chat window, mic, speaker indicator
  mock/
    mockRobot.ts       simulator speaking the real protocol over real TCP
android/app/src/main/java/.../WallETcpPlugin.java   a deliberately dumb socket
tests/                   153 tests
```

`RobotCore` owns the protocol and holds no reference to Node or the DOM, which
is what lets the server and the phone share it. The Kotlin plugin knows three
things: open a socket, write bytes, read bytes.

---

## Testing

```bash
npm test        # 153 tests
npm run build   # typecheck + bundle
```

| Area | Covered in |
|---|---|
| Every protocol constant vs the firmware header | `walleProtocol.test.ts` |
| Packet encode/decode, text frames, stream framing, garbage recovery | `walleProtocol.test.ts` |
| Command validation and clamping | `walleProtocol.test.ts` |
| Joystick dead zone, 8-way resolution, command mapping | `joystick.test.ts` |
| TCP against the simulator: drive, stop, keepalive, watchdog, cliff, voice | `robotLink.test.ts` |
| **The on-device path**, as the phone runs it | `directLink.test.ts` |
| Hostile stream: resync, bad magic, inbound command frames, 64 KB chunk | `robotLink.test.ts` |
| Persona fits the frame, keeps the signature, clears blocks | `directLink.test.ts` |
| Server end-to-end in demo mode | `appServer.test.ts` |

---

## Configuration

Copy `.env.example` to `.env`. Everything is optional.

| Variable | Default | |
|---|---|---|
| `PORT` | `8787` | companion server port |
| `WALLE_ROBOT_HOST` | — | connect on startup |
| `WALLE_ROBOT_PORT` | `8080` | must match `APP_TCP_PORT` |
| `WALLE_DEMO` | `0` | start in demo mode |
| `WALLE_RECONNECT` | `1` | retry with backoff |

Settings edited in the UI persist to `.walle/settings.json`. On the phone the
IP is remembered by the app; the companion server is only used in a browser.

There is **no API key anywhere**. The robot holds its own Gemini key and runs
its own speech pipeline; the app only sends `ask` and displays the answer.

---

## Android

See **[docs/ANDROID.md](docs/ANDROID.md)** for the toolchain, the
`local.properties` trap that breaks the build on Windows, and release signing.

---

## Remaining hardware-dependent work

Blocked on the physical robot, not on the app:

- **End-to-end validation.** The protocol is verified against a simulator that
  implements the same header, not against silicon.
- **`SET_PERSONA` (0x1d).** New in this build. Until the firmware implements
  it, the robot will answer in whatever voice it has compiled in — the app
  still sends the frame and the prompt is documented in the API doc.
- **Speech input on the phone.** The Web Speech API needs Google's speech
  service and patchy WebView support; the button says so plainly when
  unavailable, and typing always works.
- **Sensor poll rate.** 5 Hz is the integration doc's ceiling. On the real
  ultrasonic sensor this may need to be slower.
- **Step distance.** `STEP_DISTANCE_CM` is a config constant; with no wheel
  encoders, "4 steps" is a timed estimate, not a measurement.
- **Drive feel.** Motor speed, turn duration and PID are firmware-side. The app
  sends intents only and cannot compensate.