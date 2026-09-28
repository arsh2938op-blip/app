/**
 * Companion-server configuration.
 *
 * Secrets (Gemini key) live ONLY here / in the process environment.
 * They are never bundled into the browser build and never sent to the ESP32.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface AppConfig {
  port: number;
  host: string;
  /** Token the browser must present on the app WebSocket. */
  appToken: string;
  /** Optional shared secret the ESP32 requires in its handshake header. */
  robotToken?: string;
  /** Gemini API key, held server-side only. */
  geminiApiKey?: string;
  geminiModel: string;
  /** Fall back to a requestId timeout when the robot never replies. */
  requestTimeoutMs: number;
  reconnect: { enabled: boolean; minDelayMs: number; maxDelayMs: number };
  rateLimit: { windowMs: number; maxCommands: number };
  discovery: { enabled: boolean; timeoutMs: number };
  lastKnownHost: string | null;
  demoMode: boolean;
  defaultMotorSpeed: number;
  defaultVolume: number;
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

  const explicitToken = str("WALLE_APP_TOKEN");
  const port = num("PORT", 8787);

  return {
    port,
    host: str("HOST") ?? "0.0.0.0",
    // A random per-boot token still requires a page reload to recover, and the
    // token is embedded in index.html by the dev server, not hard-coded.
    appToken: explicitToken ?? `walle-app-${randomBytes(16).toString("hex")}`,
    robotToken: str("WALLE_ROBOT_TOKEN"),
    geminiApiKey: str("GEMINI_API_KEY"),
    geminiModel: str("GEMINI_MODEL") ?? "gemini-2.0-flash",
    requestTimeoutMs: num("WALLE_REQUEST_TIMEOUT_MS", 5000),
    reconnect: {
      enabled: bool("WALLE_RECONNECT", true),
      minDelayMs: num("WALLE_RECONNECT_MIN_MS", 500),
      maxDelayMs: num("WALLE_RECONNECT_MAX_MS", 10_000),
    },
    rateLimit: {
      windowMs: num("WALLE_RATE_WINDOW_MS", 1000),
      maxCommands: num("WALLE_RATE_MAX", 25),
    },
    discovery: {
      enabled: bool("WALLE_DISCOVERY", true),
      timeoutMs: num("WALLE_DISCOVERY_TIMEOUT_MS", 4000),
    },
    lastKnownHost: str("WALLE_ROBOT_HOST") ?? null,
    demoMode: bool("WALLE_DEMO", false),
    defaultMotorSpeed: num("WALLE_MOTOR_SPEED", 0.6),
    defaultVolume: num("WALLE_VOLUME", 0.7),
  };
}
