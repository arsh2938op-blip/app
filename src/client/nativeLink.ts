/**
 * The on-device transport: a raw TCP socket provided by the Android plugin.
 *
 * The plugin knows how to open a socket and move bytes. Everything of
 * consequence — framing, the 700 ms watchdog, reconnect — stays in
 * `RobotCore`, shared with the desktop server, so the two can never disagree
 * about what a command means.
 *
 * In a desktop browser there is no such plugin, so `isNativeLinkAvailable()`
 * returns false and the app falls back to the companion server.
 */

import type { ByteTransport } from "../shared/robotCore.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface WallETcpPlugin {
  connect(opts: { host: string; port: number }): Promise<void>;
  send(opts: { data: string }): Promise<void>;
  close(): Promise<void>;
  isConnected(): Promise<{ connected: boolean }>;
  addListener(event: "data", cb: (e: { data: string }) => void): void;
  addListener(event: "closed", cb: (e: { reason: string }) => void): void;
  removeAllListeners(event: string): void;
}

function plugin(): WallETcpPlugin | null {
  const cap = (globalThis as any).Capacitor;
  if (!cap?.isNativePlatform?.()) return null;
  try {
    return cap.Plugins?.WallETcp ?? null;
  } catch {
    return null;
  }
}

/** True when the app can speak TCP itself, with no companion server. */
export function isNativeLinkAvailable(): boolean {
  return plugin() !== null;
}

/** Human label for the UI, so the operator knows which path is in use. */
export function linkModeLabel(): "Direct to robot" | "Via companion server" {
  return isNativeLinkAvailable() ? "Direct to robot" : "Via companion server";
}

/** base64 -> bytes, without pulling in a dependency. */
function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  // Chunked, because spreading a whole frame into apply() overflows the stack.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * A ByteTransport backed by the Android plugin.
 *
 * `onData` and `onClose` are set by the owner before `open()` is called.
 */
export class NativeTcpTransport implements ByteTransport {
  onData: (chunk: Uint8Array) => void = () => {};
  onClose: (reason: string) => void = () => {};

  private readonly p: WallETcpPlugin;
  private listening = false;

  constructor() {
    const p = plugin();
    if (!p) throw new Error("WallETcp plugin is not available on this platform");
    this.p = p;
  }

  async open(host: string, port: number): Promise<void> {
    this.attach();
    await this.p.connect({ host, port });
  }

  write(bytes: Uint8Array): boolean {
    // Fire-and-forget: RobotCore already knows whether the link is live, and
    // making every held-direction re-send await a bridge round trip would add
    // latency to the safety-critical path.
    void this.p.send({ data: toBase64(bytes) }).catch(() => {});
    return true;
  }

  close(): void {
    if (this.listening) {
      this.p.removeAllListeners("data");
      this.p.removeAllListeners("closed");
      this.listening = false;
    }
    void this.p.close().catch(() => {});
  }

  private attach(): void {
    if (this.listening) return;
    this.listening = true;
    this.p.addListener("data", (e) => this.onData(fromBase64(e.data)));
    this.p.addListener("closed", (e) => this.onClose(e.reason ?? "closed by peer"));
  }
}