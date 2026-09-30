/**
 * Keeps the screen awake while the app is in the foreground.
 *
 * This is a safety requirement, not a convenience. The robot stops itself if
 * the app goes quiet for 700 ms (APP_TIMEOUT_MS in the firmware). Android
 * will happily lock a screen that has been idle for a few seconds, which
 * would silently stop a robot in the middle of a manoeuvre — so during a
 * live demo, the screen locking is a real way to make WALL-E stop moving.
 *
 * It uses the Wake Lock API where available and silently does nothing where
 * it is not, because a missing feature must never break the app.
 */

let sentinel: WakeLockSentinel | null = null;
let listening = false;

/** The Wake Lock API, absent in some browsers and in jsdom. */
function nav(): Navigator | null {
  if (typeof navigator === "undefined") return null;
  return "wakeLock" in navigator ? (navigator as Navigator) : null;
}

/** Request the lock. Safe to call repeatedly. */
export async function acquireWakeLock(): Promise<void> {
  const n = nav() as (Navigator & { wakeLock?: WakeLock }) | null;
  if (!n?.wakeLock) return;
  if (sentinel && !sentinel.released) return;

  try {
    sentinel = await n.wakeLock.request("screen");
    // The OS revokes the lock when the tab or app is hidden; take it again
    // as soon as we come back, so returning to the app restores normal use.
    if (!listening) {
      listening = true;
      const onVisible = () => {
        if (document.visibilityState === "visible") void acquireWakeLock();
      };
      document.addEventListener("visibilitychange", onVisible);
    }
  } catch {
    // Denied, or the device has no wake lock support. Not fatal: the app
    // still works, and the firmware's own watchdog still stops the robot.
    sentinel = null;
  }
}

export function releaseWakeLock(): void {
  const s = sentinel;
  sentinel = null;
  if (!s || s.released) return;
  void s.release().catch(() => {});
}
