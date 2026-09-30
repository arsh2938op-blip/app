/**
 * Points the Android build at an SDK directory.
 *
 * Usage: node scripts/use-sdk.mjs <path>
 *
 * WHY THIS EXISTS
 * ---------------
 * On Windows, AGP mis-parses `android/local.properties` and fails the build
 * with the famously unhelpful:
 *
 *   Could not determine the dependencies of task ':app:compileDebugJavaWithJavac'
 *     > java.io.IOException: The filename, directory name, or volume label syntax is incorrect
 *
 * The cause is inside AGP's SdkLocator: when the `sdk.dir` value is not
 * recognised as absolute it falls back to `File(rootDir, path).canonicalFile`,
 * and on Windows that concatenation throws error 123. The message names
 * neither the file nor the setting, so it costs hours to find.
 *
 * The reliable fix is to point AGP at the SDK with the ANDROID_HOME
 * environment variable instead and not write local.properties at all.
 */

import { existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const androidDir = resolve(here, "..", "android");
const localProperties = resolve(androidDir, "local.properties");

/** A usable SDK has platforms and build-tools under it. */
function looksLikeSdk(dir) {
  return existsSync(resolve(dir, "platforms")) && existsSync(resolve(dir, "build-tools"));
}

const arg = process.argv[2];

if (!arg) {
  // Report the first plausible SDK so the caller can act on it.
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    `${process.env.LOCALAPPDATA ?? ""}\\Android\\Sdk`,
    `${process.env.HOME ?? ""}/Android/Sdk`,
  ].filter(Boolean);

  const found = candidates.find((c) => looksLikeSdk(c));
  if (found) {
    console.log(found);
    process.exit(0);
  }
  console.error(
    "No Android SDK found. Install Android Studio, or pass the path:\n" +
      "  node scripts/use-sdk.mjs <sdk-path>",
  );
  process.exit(1);
}

const sdkDir = resolve(arg);
if (!looksLikeSdk(sdkDir)) {
  console.error(
    `"${sdkDir}" does not look like an Android SDK ` +
      "(expected platforms/ and build-tools/ inside it).",
  );
  process.exit(1);
}

// Remove the file AGP chokes on. Pointing at the SDK is done with
// ANDROID_HOME, which is set by the npm script that calls this.
if (existsSync(localProperties)) {
  writeFileSync(localProperties, "");
  console.log(`cleared android/local.properties (AGP mis-parses it on Windows)`);
}

console.log(sdkDir);