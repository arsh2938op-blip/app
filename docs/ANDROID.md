# Building the APK

The Android build needs three things: the Android SDK, a JDK that Gradle
accepts, and a working `sdk.dir`. The third one is the trap.

## The `local.properties` trap

AGP on Windows mis-parses `android/local.properties`. When the `sdk.dir` value
is not treated as absolute, AGP falls back to
`File(rootDir, path).canonicalFile`, and on Windows that concatenation throws
error 123. The build dies with:

```
Could not determine the dependencies of task ':app:compileDebugJavaWithJavac'
  > java.io.IOException: The filename, directory name, or volume label syntax is incorrect
```

The message names neither the file nor the setting, and the stack points deep
inside Gradle, so it is easy to lose a day to it.

**Fix: point at the SDK with `ANDROID_HOME` and do not use
`local.properties`.**

```powershell
$env:ANDROID_HOME = "C:\Users\<you>\AppData\Local\Android\Sdk"
```

`node scripts/use-sdk.mjs` locates the SDK and clears the offending file:

```powershell
node scripts/use-sdk.mjs
```

It prints the path to export. With no argument it searches the usual
locations and prints the first one that has `platforms/` and `build-tools/`.

## JDK version

Gradle does not run on JDK 25. Use **JDK 17 or 21**:

```powershell
$env:JAVA_HOME = "C:\Program Files\Java\jdk-17"
```

Capacitor's generated project pins Gradle 8.2.1 and AGP 8.2.1, which work on
JDK 17.

## Full sequence

```powershell
$env:ANDROID_HOME = "C:\Users\<you>\AppData\Local\Android\Sdk"
$env:JAVA_HOME   = "C:\Program Files\Java\jdk-17"

node scripts/use-sdk.mjs     # clear local.properties
npm install
npm run android:apk
```

Output:

```
android/app/build/outputs/apk/debug/app-debug.apk
```

Install with `adb install -d <path>`, or copy the file to the phone and open
it after enabling *install from unknown sources*.

## Verified

Built and inspected on this machine:

- package `innovationday.walle.app`, label `WALL-E`
- minSdk 22, targetSdk 34, compileSdk 34
- permissions: INTERNET, ACCESS_NETWORK_STATE, ACCESS_WIFI_STATE, WAKE_LOCK
- the built UI is packaged under `assets/public/`
- 3.8 MB debug APK

## How the app connects

The phone runs the UI. The **companion server** on the laptop is what speaks
TCP to the robot, because a browser cannot open a raw TCP socket. Both must be
running:

```powershell
npm run dev:server   # laptop
```

The APK bundles the built UI, so it does not need Vite. To use the phone
entirely on its own, run the companion server on an always-on machine.

### Cleartext HTTP

The companion server speaks plain HTTP and WebSocket on the LAN, where there
is no certificate authority, so `android:usesCleartextTraffic="true"` is set
in the manifest. That is acceptable on a trusted demo network and **should be
replaced with TLS before this goes anywhere real.**

## Release signing

```powershell
keytool -genkey -v -keystore walle-release.keystore `
  -alias walle -keyalg RSA -keysize 2048 -validity 10000
```

`android/keystore.properties` (git-ignored):

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

## App identity

| | |
|---|---|
| Package | `innovationday.walle.app` |
| Name | WALL-E |
| Orientation | full sensor, portrait and landscape |

Changing either is a `capacitor.config.ts` edit plus a re-sync.

## Screen wake lock

The app requests a screen wake lock and the manifest declares `WAKE_LOCK`.
This is a **safety requirement, not a convenience**: the robot stops itself
if the app goes quiet for 700 ms, and Android locks an idle screen within
seconds. A locked screen means a silent app, which means a robot that stops
mid-manoeuvre. The app also releases the joystick on `visibilitychange` and on
window blur, so a genuine background still stops cleanly.

## Troubleshooting

**`Unsupported class file major version`**
Set `JAVA_HOME` to JDK 17 or 21.

**`SDK location not found`**
Export `ANDROID_HOME`, and run `node scripts/use-sdk.mjs`.

**`filename, directory name, or volume label syntax is incorrect`**
You have a `local.properties` with a `sdk.dir` in it. Delete it and use
`ANDROID_HOME` instead.

**APK installs but shows a blank screen**
The build ran before the client was built. `npm run android:apk` builds first;
if you ran `npx cap sync` alone, run `npm run build` and sync again.

**App cannot reach the server**
Phone and computer must be on the same network, and the server must have bound
to `0.0.0.0` (the default) rather than `127.0.0.1`.
