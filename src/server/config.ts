/**
 * Companion-server configuration.
 *
 * The robot needs no secrets: it speaks a fixed binary protocol with no
 * handshake, exactly like the radio remote. The only optional credential is
 * a bearer token, used only if a future firmware build requires one.
 *
 * There is no API key anywhere. The ESP32-S3 holds its own Gemini key and
 * does its own STT-to-text work off the typed `ask`; the app never sees it
 * and never needs one.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_ROBOT_PORT } from "../shared/walleProtocol.js";

export interface AppConfig {
  port: number;
  host: string;
  /** Token the browser must present on the app WebSocket. */
  appToken: string;
  /** Optional bearer secret the robot would require. */
  robotToken?: string;
  defaultRobotHost: string | null;
  defaultRobotPort: number;
  requestTimeoutMs: number;
  reconnect: { enabled: boolean; minDelayMs: number; maxDelayMs: number };
  rateLimit: { windowMs: number; maxCommands: number };
  demoMode: boolean;
}

/** Minimal .env loader — avoids a dependency for ~30 lines. */
function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

function str(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export function loadConfig(rootDir = process.cwd()): AppConfig {
  loadDotEnv(resolve(rootDir, ".env"));

  return {
    port: num("PORT", 8787),
    host: str("HOST") ?? "0.0.0.0",
    // A random per-boot token; the browser fetches it from /api/session on
    // its own origin, so nothing secret is ever baked into the bundle.
    appToken: str("WALLE_APP_TOKEN") ?? `walle-app-${randomBytes(16).toString("hex")}`,
    robotToken: str("WALLE_ROBOT_TOKEN"),
    defaultRobotHost: str("WALLE_ROBOT_HOST") ?? null,
    defaultRobotPort: num("WALLE_ROBOT_PORT", DEFAULT_ROBOT_PORT),
    requestTimeoutMs: num("WALLE_REQUEST_TIMEOUT_MS", 5000),
    reconnect: {
      enabled: bool("WALLE_RECONNECT", true),
      minDelayMs: num("WALLE_RECONNECT_MIN_MS", 500),
      maxDelayMs: num("WALLE_RECONNECT_MAX_MS", 10_000),
    },
    rateLimit: {
      windowMs: num("WALLE_RATE_WINDOW_MS", 1000),
      maxCommands: num("WALLE_RATE_MAX", 60),
    },
    demoMode: bool("WALLE_DEMO", false),
  };
}
