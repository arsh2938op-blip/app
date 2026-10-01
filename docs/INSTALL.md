# Downloading and installing the app

**You do not need Node, npm, Android Studio or a JDK to run this.** The APK is
built by GitHub and downloaded like any other file.

---

## On a phone (the normal case)

### 1. Download

Go to the repository's **Releases** page:

```
https://github.com/arsh2938op-blip/app/releases
```

Pick the latest release and download **`walle-vulkan-v1.0.0.apk`**.

The APK is also attached to every successful build under the repository's
**Actions** tab, if a release is not there yet.

### 2. Install

Open the downloaded file on the phone. Android will warn that it came from
outside the Play Store. That is expected for a debug build:

- **Settings → Allow from this source**, or
- **Install anyway**

### 3. Connect

1. Power the robot. Its IP address is printed on the **serial log at boot**.
   Copy it, e.g. `192.168.1.42`.
2. Put the phone and the robot on the **same Wi-Fi**.
3. Open Vulkan → **Connect** tab → type the IP → **Connect**.

There is no laptop, no server and nothing else to start. The app opens the
robot's TCP connection itself.

---

## What gets built, and when

Nothing needs to be installed to produce the APK. Push a **tag** and GitHub
builds it:

```bash
git tag v1.0.0
git push origin v1.0.0
```

`.github/workflows/android.yml` then:

1. typechecks and runs all 153 tests,
2. builds the APK on GitHub's runners,
3. attaches it to a Release for that tag.

A release page looks like:

```
v1.0.0
  walle-vulkan-v1.0.0.apk     <- download this
  Assets / Source code / ...
```

Want a new version? Change `versionName` in `android/app/build.gradle`, bump
the tag, push. Old releases stay downloadable.

---

## The desktop browser version (optional, needs Node)

Only needed for development, or for running the UI on a laptop. The phone does
not need it.

```bash
npm install
npm run dev:server     # companion server, port 8787
npm run dev:client     # UI, port 5173
```

Press **Demo mode** to drive a simulated robot with no hardware.

A browser cannot open a raw TCP socket, so in this mode a companion server on
the computer carries the robot's traffic. The phone has a native socket and
does not need the server — which is why the phone build is the one to demo
from.

---

## Building the APK yourself (only if you want to)

Needs JDK 17, the Android SDK, and Node. Usually not necessary, because the
tag-and-push route above does it for you.

```bash
# JDK 17 — Gradle does not run on newer JDKs
$env:JAVA_HOME = "C:\Program Files\Java\jdk-17"
$env:ANDROID_HOME = "C:\Users\<you>\AppData\Local\Android\Sdk"

npm install
node scripts/use-sdk.mjs     # clears android/local.properties; see docs/ANDROID.md
npm run android:apk
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`.

> **On Windows, do not use `android/local.properties`.** The Android Gradle
> Plugin mis-parses it and the build dies with
> `The filename, directory name, or volume label syntax is incorrect`. Point at
> the SDK with `ANDROID_HOME` instead. `docs/ANDROID.md` explains why.

---

## Troubleshooting

**"App not installed"** — an older build with a different signature is still
installed. Uninstall Vulkan first, then install again. This is normal after
switching between debug and release keys.

**Install button does nothing** — the file did not finish downloading. APKs are
around 39 MB.

**"App keeps stopping" on launch** — the phone is likely Android 6 or older. The
build targets `minSdk 22`, so anything from Android 5.1 upward is supported.

**Connects then says offline** — phone and robot are on different networks, or
a guest Wi-Fi is isolating clients from each other. Phone and robot must be on
the same subnet.

**Mic button greyed out** — speech input needs Google's speech service on the
device and permission for the microphone. Typing always works. See below.

---

## Notes on this build

**Signed with the debug key.** Android accepts it with "install anyway", but it
is not suitable for the Play Store. For a real release, add a signing key as
described in `docs/ANDROID.md`.

**The persona needs firmware support.** The app sends `set_persona` (0x1d) on
connect so Vulkan knows its name and tone. Until the firmware implements it,
the robot answers in whatever voice is compiled in. The prompt is documented in
`docs/WALL-E_ROBOT_API.md` §11.