# Building the Android APK

The app is a React web UI wrapped in a native Android shell with Capacitor.
The UI is byte-for-byte the same code that runs in a browser — Capacitor only
provides the APK.

---

## What you get

```bash
npm run android:apk
```

→ `android/app/build/outputs/apk/debug/app-debug.apk`

Install it:

```bash
adb install -d android/app/build/outputs/apk/debug/app-debug.apk
```

or copy the APK to the phone and open it (enable *install from unknown
sources*).

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node | 20+ | already required |
| JDK | 17 or 21 | **Gradle does not support JDK 25 yet** |
| Android SDK | platform 34, build-tools 34 | Android Studio installs this |
| Gradle | 8.7 | fetched automatically by the wrapper |

> **JDK version matters.** If `java -version` reports 25, the Gradle wrapper
> will refuse to run. Point `JAVA_HOME` at a 17 or 21 install:
>
> ```powershell
> $env:JAVA_HOME = "C:\Program Files\Java\jdk-17"
> ```

If Android Studio is installed, the SDK is already there and
`android/local.properties` just needs the path:

```properties
sdk.dir=C:\Users\<you>\AppData\Local\Android\Sdk
```

---

## Without Android Studio

Install the command-line tools, then let Gradle use them:

```powershell
# 1. command-line tools
New-Item -ItemType Directory -Force -Path $env:LOCALAPPDATA\android\cmdline-tools
#    download commandlinetools-win-*_latest.zip from
#    https://developer.android.com/studio#command-line-tools-only
#    unzip so that sdkmanager.bat ends up at
#      $env:LOCALAPPDATA\android\cmdline-tools\latest\bin\sdkmanager.bat

# 2. packages
$sdk = "$env:LOCALAPPDATA\android\sdk"
& "$env:LOCALAPPDATA\android\cmdline-tools\latest\bin\sdkmanager.bat" --sdk_root=$sdk --licenses
& "$env:LOCALAPPDATA\android\cmdline-tools\latest\bin\sdkmanager.bat" --sdk_root=$sdk "platform-tools" "platforms;android-34" "build-tools;34.0.0"

# 3. point the project at the SDK
"sdk.dir=$sdk" | Out-File -Encoding ascii android\local.properties
```

Then `npm run android:apk`.

---

## How the app connects

The phone runs the UI. The **companion server** on the laptop is what speaks
TCP to the robot. Both must be running:

```bash
npm run dev:server   # on the laptop
npm run dev:client   # or install the APK and use that
```

The APK bundles the built UI, so it does not need Vite. It does need to reach
the companion server over the local network.

**To use the phone with no laptop**, run the companion server on an always-on
machine and point the app at its address. The app's server URL is baked in at
build time via the Capacitor `server.url` setting in
`capacitor.config.ts` — leave it unset to use the bundled assets plus a
runtime server address, which is the default.

### Cleartext HTTP

The companion server speaks plain HTTP and WebSocket on the LAN, where there
is no certificate authority, so `android:usesCleartextTraffic="true"` is set
in the manifest. That is acceptable for a demo bench on a trusted network and
**should be replaced with TLS before this goes anywhere real.**

---

## Release build

```bash
npm run android:release
```

Needs a signing key. Create one:

```bash
keytool -genkey -v -keystore walle-release.keystore \
  -alias walle -keyalg RSA -keysize 2048 -validity 10000
```

Then create `android/keystore.properties` (git-ignored):

```properties
storeFile=../walle-release.keystore
storePassword=...
keyAlias=walle
keyPassword=...
```

Wire it into `android/app/build.gradle`:

```groovy
android {
    signingConfigs {
        release {
            def props = new Properties()
            def f = rootProject.file('keystore.properties')
            if (f.exists()) props.load(new FileInputStream(f))
            storeFile file(props['storeFile'])
            storePassword props['storePassword']
            keyAlias props['keyAlias']
            keyPassword props['keyPassword']
        }
    }
    buildTypes {
        release { signingConfig signingConfigs.release }
    }
}
```

Never commit the keystore or its passwords.

---

## App identity

| | |
|---|---|
| Package | `innovationday.walle.app` |
| Name | WALL-E |
| Orientation | full sensor — portrait and landscape both work |
| Min SDK | Capacitor 6 default (23) |
| Target SDK | 34 |

Changing the package name or launcher label is a matter of
`capacitor.config.ts` plus a re-sync, not a code change.

---

## Screen wake lock

The app requests a screen wake lock while visible, and the manifest declares
`WAKE_LOCK`. This is a **safety requirement, not a convenience**: the robot
stops itself if the app goes quiet for 700 ms, and Android will lock an idle
screen within seconds. A locked screen means a silent app, which means a robot
that stops in the middle of a manoeuvre.

The app also releases the joystick on `visibilitychange` and on window blur,
so a genuine background still stops the robot cleanly.

---

## Troubleshooting

**`Unsupported class file major version` / Gradle fails on JDK 25**
Set `JAVA_HOME` to JDK 17 or 21.

**`SDK location not found`**
Create `android/local.properties` with `sdk.dir=<path to sdk>`.

**APK installs but shows a blank screen**
The build ran before the client was built. `npm run android:apk` builds it
first; if you ran `npx cap sync` alone, run `npm run build` and sync again.

**App cannot reach the server**
Check the phone and laptop are on the same network, and that the server bound
to `0.0.0.0` (the default) rather than `127.0.0.1`. Android also blocks
cleartext HTTP by default, which the manifest override handles.
