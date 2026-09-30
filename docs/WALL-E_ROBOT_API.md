# WALL-E Robot API — as implemented by the ESP32-S3 firmware

This app is built against the **real** firmware protocol, not an invented one.
The authoritative sources are in the firmware repository:

| Source | Path |
|---|---|
| Protocol constants | `WALL-E/shared/walle_protocol.h` |
| Integration spec | `WALL-E/robot_s3/docs/APP_INTEGRATION.md` |
| App link (TCP) | `WALL-E/robot_s3/src/app_link.{h,cpp}` |
| Command dispatch | `WALL-E/robot_s3/src/command_dispatch.{h,cpp}` |
| Timing/safety config | `WALL-E/robot_s3/include/config.h` |

The TypeScript mirror of all of this is
[`src/shared/walleProtocol.ts`](../src/shared/walleProtocol.ts), and
`tests/walleProtocol.test.ts` asserts every constant against the values in the
firmware header. If the firmware changes a command id, the tests fail.

**The app is a second controller.** It speaks the same 10-byte packets as the
ESP32-WROOM radio remote, over TCP instead of ESP-NOW. The robot funnels both
into one dispatcher, so the app and the remote cannot disagree about what a
command means.

---

## 1. Transport

| | |
|---|---|
| Transport | **raw TCP** — not HTTP, not WebSocket, not JSON |
| Port | **8080** (`APP_TCP_PORT`) |
| Addressing | The robot's IP, printed on its serial log at boot |
| Handshake | None |
| Secret | None |

A browser cannot open a raw TCP socket, which is why the companion server
exists. It does the framing; the UI sends ordinary JSON.

### Why there is no discovery

The firmware contains **no mDNS** — I checked every source file. WALL-E does
not advertise itself, so `wall-e.local` will not resolve and there is nothing
to browse for. The app therefore:

1. asks for the IP in the Connect tab, and
2. remembers it, so a demo needs the IP typed once.

`GET /api/scan` exists but only echoes the configured host. It is a
placeholder, not a working scanner, and the UI says so.

---

## 2. The 700 ms watchdog — the thing that will bite you

While the app is **driving**, it must send **something at least every 700 ms**
(`APP_TIMEOUT_MS`) or the robot stops and releases the wheels.

This is deliberate. A phone whose screen locks, or an app whose tab is
backgrounded, must never leave the robot driving.

The app satisfies it three ways:

| Situation | What the app sends |
|---|---|
| Direction held | Re-sends the held command every **250 ms** with `FLAG_HELD` |
| Connected, not driving | `PING` every 300 ms |
| Driving, then finger lifts | `STOP` immediately, then disarms the keepalive |

The 250 ms cadence is what the radio remote uses; it leaves comfortable margin
for a congested Wi-Fi network.

The app also holds a **screen wake lock** while visible, because Android will
lock an idle screen after a few seconds — and a locked screen means a silent
app, which means a stopped robot mid-manoeuvre.

When the robot stops you for a timeout it sends `ERROR` / `LINK_TIMEOUT`. The
app treats this as a *notice*, not a disconnect: the link is still up, so it
just needs the keepalive running again.

---

## 3. Frames

### 3.1 Fixed packet — 10 bytes, little endian

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 1 | magic | `0xA5` always. Used to resynchronise. |
| 1 | 1 | version | `0x01` |
| 2 | 1 | type | `0x01` COMMAND, `0x02` STATUS, `0x03` TEXT |
| 3 | 1 | cmd | command or status id |
| 4 | 1 | value | small argument: state, error, expression |
| 5 | 1 | seq | rolling counter 0–255, wraps |
| 6 | 1 | flags | bit 0 = `WALLE_FLAG_HELD` (0x01) |
| 7 | 1 | reserved | 0 |
| 8 | 2 | arg | `uint16` LE — step count, degrees, millivolts |

Encoded with `DataView`, never a packed struct: C struct padding rules differ
between platforms and the firmware asserts the type is exactly 10 bytes.

### 3.2 Text frame — 8-byte header + UTF-8 payload

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | magic `0xA5` |
| 1 | 1 | version `0x01` |
| 2 | 1 | type `0x03` TEXT |
| 3 | 1 | op — `0x01` ask, `0x02` speak, `0x03` reply |
| 4 | 1 | flags |
| 5 | 2 | len `uint16` LE, 1–240 |
| 6–7 | | padding to 8 |
| 8… | len | UTF-8, no terminator, no escaping |

`ASK` and `SPEAK` are announced as a fixed packet, then the words follow
**immediately** in a text frame.

Text is truncated at **240 bytes on a character boundary**, not a byte
boundary — slicing encoded bytes at 240 would cut a 3-byte character in half
and hand the robot invalid UTF-8.

### 3.3 Stream framing — a bug the spec walks into

TCP has no message boundaries. The reference pseudocode in
`APP_INTEGRATION.md` decides a frame is fixed-size first, and only looks for a
text header at offset 8. That cannot work: a text frame whose total length
happens to be 10 bytes (an 8-byte header plus 2 bytes of text) is
indistinguishable from a fixed packet by length alone, and gets misparsed.

The app instead reads the **type byte at offset 2**, which is unambiguous, as
soon as three bytes have arrived. It also drops a frame whose version byte
does not follow the magic, so a partial frame from a previous connection is
never decoded as garbage.

`tests/walleProtocol.test.ts` covers 10-byte text frames, back-to-back text
frames, and stray-byte recovery.

---

## 4. Commands

`payload` — the fixed packet has one `arg` field; there is no JSON payload.

### Locomotion (held)

| Id | Name | Behaviour |
|---|---|---|
| `0x01` | `move_forward` | drives while held; re-send or it stops |
| `0x02` | `move_backward` | as above |
| `0x03` | `turn_left` | arc left, held |
| `0x04` | `turn_right` | arc right, held |
| `0x05` | `rotate_left` | pivot on the spot, held |
| `0x06` | `rotate_right` | pivot on the spot, held |
| `0x07` | `stop` | **highest priority from any source.** Never `HELD`. |

### Timed motions (finish on their own)

| Id | Name | `arg` |
|---|---|---|
| `0x17` | `move_steps` | 1–50 steps (`STEP_DISTANCE_CM` = 10 cm) |
| `0x18` | `turn_around` | — (180°) |
| `0x1c` | `turn_degrees` | 1–360° |

No keepalive, and **no `stop` afterwards** — sending one is harmless but
pointless. Still subject to the cliff sensor.

### Modes

| Id | Name |
|---|---|
| `0x10` | `dance` |
| `0x11` | `explore` |
| `0x12` | `idle` |
| `0x13` | `autonomous_on` |
| `0x14` | `autonomous_off` |

### Voice

| Id | Name | Notes |
|---|---|---|
| `0x15` | `talk` | robot decides what to say, then says it |
| `0x16` | `joke` | robot decides the joke |
| `0x1a` | `ask` | **then** a text frame with the question |
| `0x1b` | `speak` | **then** a text frame, said verbatim |

**The robot has no microphone.** Speech-to-text is not on the robot and not in
this app. You type the question; the robot answers in text and speaks it out
loud. The answer arrives as a `TEXT` frame with `op = 0x03`.

### Expressions

| Id | Name |
|---|---|
| `0x20` | `expression_happy` |
| `0x21` | `expression_thinking` |
| `0x22` | `expression_surprised` |
| `0x23` | `expression_confused` |
| `0x24` | `expression_idle` |

Five expressions, not nine. The firmware defines five.

### Sensors and housekeeping

| Id | Name |
|---|---|
| `0x19` | `read_sensor` |
| `0x30` | `hello` |
| `0x31` | `ping` |
| `0x32` | `bye` |

---

## 5. Status

| Id | Name | Carries |
|---|---|---|
| `0x80` | `WELCOME` | `value` = robot state, on connect and after `hello` |
| `0x81` | `ACK` | `value` = the command that ran |
| `0x82` | `ERROR` | `value` = error code |
| `0x83` | `ROBOT_STATE` | `value` = robot state |
| `0x84` | `REMOTE_STATE` | `value` = radio remote state 0–3 |
| `0x85` | `BATTERY` | `arg` = millivolts, 0 = unknown — **never sent today** |
| `0x86` | `PONG` | `value` = robot state |
| `0x87` | `SENSOR` | `value` = cliff state, `arg` = ground distance in cm |
| `0x88` | `CLIFF` | `value` = cliff state, on transition |

### Robot states

| # | Name | |
|---|---|---|
| 0 | `boot` | starting up |
| 1 | `idle` | awake |
| 2 | `thinking` | **wheels blocked** |
| 3 | `speaking` | **wheels blocked** |
| 4 | `exploring` | driving itself |
| 5 | `observing` | paused, looking around |
| 6 | `moving` | mid-manoeuvre |
| 7 | `dancing` | |
| 8 | `remote` | a controller owns the wheels |
| 9 | `offline` | no Wi-Fi, AI paused |

The robot re-sends `ROBOT_STATE` about once a second as a keepalive floor. The
app's activity feed **collapses consecutive duplicates**, because treating
each one as a screen update would make the log unreadable.

### Cliff states

| # | Name | |
|---|---|---|
| 0 | `unknown` | not configured, or no reading yet |
| 1 | `ground` | safe |
| 2 | `warn` | near the edge, driving slowly |
| 3 | `drop` | **no floor — stopped** |
| 4 | `fault` | **sensor not responding — stopped** |

`arg` is the vertical distance to the floor in cm. This is the difference
between "the robot is stuck" and "the robot correctly refused to walk off the
table", so the app shows it prominently.

### Errors

| # | Name | What the app shows |
|---|---|---|
| 1 | `BAD_PACKET` | Bad packet from the robot |
| 2 | `UNKNOWN_CMD` | WALL-E did not recognise that command |
| 3 | `NOT_CONFIGURED` | That feature is not wired up on this robot |
| 4 | `BUSY` | The handheld remote has control |
| 5 | `CLIFF` | WALL-E stopped at the edge — pick it up or move it back |
| 6 | `SENSOR_FAULT` | WALL-E's distance sensor is not responding |
| 7 | `BAD_ARG` | That value was out of range |
| 8 | `LINK_TIMEOUT` | WALL-E stopped driving because the app went quiet |

The wording is taken verbatim from the integration doc's "what the app should
show" column, so the UI never invents its own phrasing for a safety refusal.
`CLIFF` and `SENSOR_FAULT` are **not retried** — they are stop conditions.

---

## 6. Priority and safety

Above the dispatcher's priority table, **safety wins**: every motion command
is offered to the safety guard first. A cliff, a dead sensor, or a
conversation in progress refuses the command, whatever asked for it.

- `STOP`, `BYE` and `IDLE` from any source always run.
- Exactly one controller owns the wheels at a time.
- While `thinking` or `speaking`, movement is refused with `BUSY` — a robot
  that rolls while talking cannot be heard and cannot be stopped.

The app surfaces all of this rather than fighting it. The joystick greys out
and a notice appears explaining why.

---

## 7. What the app cannot do, and why

| Missing | Reason |
|---|---|
| Microphone / STT | The robot has no mic, and the app has no speech provider. Type instead. |
| Camera view | The camera is compiled out on the ESP32-S3. |
| Battery gauge | `BATTERY` exists in the protocol but no sensor feeds it. The row is hidden until a real reading arrives. |
| Audio playback | The robot streams TTS to its own amplifier; it sends no audio back. |
| Discovery | No mDNS in the firmware. |
| Distances | No wheel encoders. "4 steps" is a timed estimate from `STEP_DISTANCE_CM`, not a measurement. |

---

## 8. Verifying the app against real hardware

1. Power the robot and note the IP from its serial log.
2. Start the companion server: `npm run dev:server`.
3. Start the UI: `npm run dev:client`.
4. Connect tab → enter the IP → **Connect**.

Or prove the framing without the app at all:

```python
import socket, struct, time
HOST, PORT = "192.168.1.42", 8080

def packet(cmd, arg=0, value=0, flags=0, seq=0):
    return struct.pack("<BBBBBBBB H", 0xA5, 0x01, 0x01, cmd, value, seq, flags, 0, arg)

s = socket.create_connection((HOST, PORT), timeout=5)
s.sendall(packet(0x30))     # HELLO
time.sleep(0.3)
s.sendall(packet(0x19))     # READ_SENSOR
time.sleep(0.5)
print(s.recv(512).hex(" ")) # expect a5 01 02 80 ... then a5 01 02 87 ...
```

**Before driving anything**, set the robot on the floor with clear space, and
confirm the cliff sensor reads `ground` — the status panel shows the ground
distance in centimetres. A `drop` or `fault` means WALL-E will refuse to move,
which is the correct behaviour, not a bug.
