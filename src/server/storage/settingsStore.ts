/**
 * Persistent settings + the robot's last known address.
 *
 * The robot's IP is printed on its serial log at boot and never changes
 * unless the network does, so remembering it is the difference between
 * tapping once and typing an IP on stage.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_ROBOT_PORT } from "../../shared/walleProtocol.js";

export interface StoredSettings {
  robotName: string;
  host: string | null;
  port: number;
  autoReconnect: boolean;
  /** Which step count the timed-motion button sends by default. */
  stepCount: number;
  /** How often the UI polls the cliff sensor, in ms. 0 disables polling. */
  sensorPollMs: number;
  demoMode: boolean;
}

export const DEFAULT_SETTINGS: StoredSettings = {
  robotName: "WALL-E",
  host: null,
  port: DEFAULT_ROBOT_PORT,
  autoReconnect: true,
  stepCount: 4,
  // 5 Hz is the integration doc's ceiling: every poll is a real ultrasonic
  // echo, so polling faster wastes the sensor without adding information.
  sensorPollMs: 200,
  demoMode: false,
};

export class SettingsStore {
  private readonly file: string;
  private data: StoredSettings;

  constructor(file: string) {
    this.file = file;
    this.data = { ...DEFAULT_SETTINGS, ...this.read() };
  }

  private read(): Partial<StoredSettings> {
    try {
      if (!existsSync(this.file)) return {};
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return {};
      return parsed as Partial<StoredSettings>;
    } catch {
      // A corrupt settings file must never stop the app from booting.
      return {};
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      // Write-then-rename so a crash mid-write cannot truncate the file.
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
      renameSync(tmp, this.file);
    } catch (err) {
      console.error("[settings] failed to persist:", (err as Error).message);
    }
  }

  get(): StoredSettings {
    return { ...this.data };
  }

  update(patch: Partial<StoredSettings>): StoredSettings {
    const merged = { ...this.data, ...patch };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete (merged as Record<string, unknown>)[k];
    }
    this.data = merged;
    this.persist();
    return this.get();
  }
}

export function defaultSettingsFile(rootDir = process.cwd()): string {
  return resolve(rootDir, ".walle", "settings.json");
}
