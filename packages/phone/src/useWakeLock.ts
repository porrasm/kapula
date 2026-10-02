import { useEffect } from "react";

/**
 * Keeps the screen on while the controller is shown (a sleeping phone drops
 * the WebSocket). Best effort: unsupported browsers just use their normal
 * screen timeout, and reconnect handles the rest.
 */
export const useWakeLock = (active: boolean) => {
  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) return;

    let lock: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        lock = await navigator.wakeLock.request("screen");
      } catch {
        /* denied (low battery etc.) — not worth surfacing */
      }
    };

    // The lock is released whenever the tab is backgrounded; retake it.
    const onVisibility = () => {
      if (!cancelled && document.visibilityState === "visible") void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void lock?.release().catch(() => undefined);
    };
  }, [active]);
};
