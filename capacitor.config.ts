import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor wraps the built web UI in a native Android WebView.
 *
 * The UI is unchanged — the same React app runs in the browser and on the
 * phone. Capacitor's only job is to give it an APK to install.
 *
 * Note on networking: the app talks to the companion server over plain HTTP
 * and WebSocket on the local network, so Android's cleartext policy has to
 * permit it. `android:usesCleartextTraffic` is set in the manifest for that
 * reason — it is scoped to a local-network companion app, not a public one.
 */
const config: CapacitorConfig = {
  appId: "innovationday.walle.app",
  appName: "WALL-E",
  webDir: "dist/client",
  android: {
    // Release builds use the same web assets; no live reload.
    webContentsDebuggingEnabled: true,
  },
  server: {
    androidScheme: "https",
  },
};

export default config;
