/**
 * Runs a Gradle task for the Android project.
 *
 * Usage: node scripts/gradle.mjs assembleDebug [-- extra args]
 *
 * Exists because `cd android && ./gradlew` in an npm script works on a POSIX
 * shell and fails on Windows, where the wrapper is `gradlew.bat`. Rather than
 * keep two platform-specific script variants, this picks the right wrapper
 * name and passes everything through.
 *
 * It also sets ANDROID_HOME from the SDK that `use-sdk.mjs` locates, which is
 * what the AGP Windows bug in docs/ANDROID.md is about: the SDK must come
 * from the environment, never from android/local.properties.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const androidDir = resolve(here, "..", "android");

const task = process.argv[2] ?? "assembleDebug";
const extra = process.argv.slice(3);

const isWindows = process.platform === "win32";
const wrapper = resolve(androidDir, isWindows ? "gradlew.bat" : "gradlew");

if (!existsSync(wrapper)) {
  console.error(`Gradle wrapper not found at ${wrapper}`);
  console.error("Run `npx cap add android` first.");
  process.exit(1);
}

/** Same search order as use-sdk.mjs, so the two agree. */
function findSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    `${process.env.LOCALAPPDATA ?? ""}\\Android\\Sdk`,
    `${process.env.HOME ?? ""}/Android/Sdk`,
  ].filter(Boolean);
  return candidates.find((c) => {
    try {
      return (
        existsSync(resolve(c, "platforms")) &&
        readdirSync(resolve(c, "platforms")).length > 0
      );
    } catch {
      return false;
    }
  });
}

const env = { ...process.env };

if (!env.ANDROID_HOME) {
  const sdk = findSdk();
  if (!sdk) {
    console.error(
      "No Android SDK found. Set ANDROID_HOME, or install Android Studio.\n" +
        "See docs/ANDROID.md for the full setup.",
    );
    process.exit(1);
  }
  env.ANDROID_HOME = sdk;
  env.ANDROID_SDK_ROOT = sdk;
  console.log(`using Android SDK at ${sdk}`);
}

// AGP mis-parses local.properties on Windows; refuse to build if it is back,
// rather than failing deep inside Gradle with an unreadable message.
const localProperties = resolve(androidDir, "local.properties");
if (isWindows && existsSync(localProperties)) {
  console.error(
    "android/local.properties makes the Android Gradle Plugin fail on Windows\n" +
      "with 'The filename, directory name, or volume label syntax is incorrect'.\n" +
      "Run:  node scripts/use-sdk.mjs",
  );
  process.exit(1);
}

const args = [wrapper, task, ...extra];
const child = spawn(args[0], args.slice(1), {
  cwd: androidDir,
  env,
  stdio: "inherit",
  shell: isWindows,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

child.on("error", (err) => {
  console.error(`failed to run Gradle: ${err.message}`);
  process.exit(1);
});