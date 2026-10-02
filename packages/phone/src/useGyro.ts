import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { GamepadGyroControl, GamepadInputValue } from "@kapula/protocol";
import {
  gyroAxisValue,
  tiltAngleBetween,
  tiltToAxes,
  type GyroTilt,
  type ScreenAngle,
} from "./gyro-utils.js";

/**
 * Access to the device tilt sensor. The pure math lives in gyro-utils.ts;
 * this module owns the messy browser part: permission and capability
 * detection, and the deviceorientation subscription.
 *
 * There is no way to know passively whether tilt input will work — iOS gates
 * deviceorientation behind a requestPermission() call that must come from a
 * user gesture (and must be repeated once per page load), other browsers
 * expose the API even on sensorless machines and just never fire events. So
 * access is a tiny state machine shared app-wide (the schema picker and the
 * controller must agree on it), verified by actually receiving a reading:
 *
 *   unknown ─ ensure ─▶ checking ─▶ granted | unavailable      (no gate)
 *   unknown ─ ensure ─▶ needs-gesture ─ request ─▶ checking ─▶ …| denied
 */

export type GyroAccess =
  | "unknown"
  | "checking"
  | "needs-gesture"
  | "granted"
  | "denied"
  | "unavailable";

type PermissionGate = { requestPermission?: () => Promise<string> };

/**
 * iOS gates orientation and motion events separately, though one prompt
 * ("Motion & Orientation Access") covers both. The raw motion stream needs
 * the motion gate too, so it is asked in the same tap.
 */
const motionGate = (): PermissionGate | null =>
  typeof DeviceMotionEvent === "undefined"
    ? null
    : (DeviceMotionEvent as unknown as PermissionGate);

let access: GyroAccess = "unknown";
const listeners = new Set<() => void>();

const setAccess = (next: GyroAccess) => {
  if (access === next) return;
  access = next;
  listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const permissionGate = (): PermissionGate | null =>
  typeof DeviceOrientationEvent === "undefined"
    ? null
    : (DeviceOrientationEvent as unknown as PermissionGate);

/** Resolves true once a reading with real tilt values arrives, false on timeout. */
const probeGyro = (timeoutMs = 1500): Promise<boolean> =>
  new Promise((resolve) => {
    const done = (usable: boolean) => {
      window.clearTimeout(timer);
      window.removeEventListener("deviceorientation", onEvent);
      resolve(usable);
    };
    const onEvent = (e: DeviceOrientationEvent) => {
      if (e.beta !== null && e.gamma !== null) done(true);
    };
    const timer = window.setTimeout(() => done(false), timeoutMs);
    window.addEventListener("deviceorientation", onEvent);
  });

// Memoized so a select-tap landing mid-probe awaits the running detection
// instead of reading the transient "checking" state.
let detection: Promise<void> | null = null;

/** Settles "unknown" as far as possible without a user gesture. */
export const ensureGyroAccess = (): Promise<void> => {
  detection ??= (async () => {
    const gate = permissionGate();
    if (!gate) {
      setAccess("unavailable");
      return;
    }
    if (typeof gate.requestPermission === "function") {
      setAccess("needs-gesture");
      return;
    }
    setAccess("checking");
    setAccess((await probeGyro()) ? "granted" : "unavailable");
  })();
  return detection;
};

/**
 * Call from a user gesture (tap) — the only context in which iOS allows the
 * permission prompt. Resolves to the settled access state.
 */
export const requestGyroAccess = async (): Promise<GyroAccess> => {
  const gate = permissionGate();
  if (!gate) {
    setAccess("unavailable");
    return access;
  }
  if (typeof gate.requestPermission !== "function") {
    await ensureGyroAccess();
    return access;
  }
  if (access === "granted" || access === "denied") return access;
  try {
    const result = await gate.requestPermission();
    // Same prompt; a motion gate that is present is granted along with it.
    // Asked anyway so a browser that ever splits them still streams motion.
    const motion = motionGate();
    if (result === "granted" && typeof motion?.requestPermission === "function") {
      await motion.requestPermission().catch(() => undefined);
    }
    if (result === "granted") {
      setAccess("checking");
      setAccess((await probeGyro()) ? "granted" : "unavailable");
    } else {
      setAccess("denied");
    }
  } catch {
    setAccess("denied");
  }
  return access;
};

/** Current gyro access, kicking off the gesture-free detection on first use. */
export const useGyroAccess = (): GyroAccess => {
  useEffect(() => {
    void ensureGyroAccess();
  }, []);
  return useSyncExternalStore(subscribe, () => access);
};

/**
 * The neutral pose locks on the first pair of consecutive readings that
 * physically agree within this many degrees. Some Android browsers fire the
 * first deviceorientation event before the sensor has settled; capturing that
 * as neutral poisons every frame until a manual recalibrate. At sensor rate a
 * steadily held phone agrees well inside this, so the lock lands within a
 * couple of events.
 */
const NEUTRAL_SETTLE_DEG = 5;

/**
 * Streams tilt input for a schema's gyro control: the first settled reading
 * after mounting becomes the neutral pose (players hold the phone how they
 * like), recalibrate() re-captures it on the next settled reading. The
 * neutral survives pauses — the pose doesn't change just because the game
 * did.
 *
 * `screenAngle` is the content's device-relative angle from the oriented
 * surface, not the OS's: the surface freezes it for the game, so a tilt
 * that makes the OS rotate the viewport never turns steering into throttle.
 */
export const useGyroInput = ({
  control,
  enabled,
  screenAngle,
  setControl,
}: {
  control: GamepadGyroControl | undefined;
  enabled: boolean;
  screenAngle: ScreenAngle;
  setControl: (id: string, value: GamepadInputValue, immediate: boolean) => void;
}): { access: GyroAccess; recalibrate: () => void } => {
  const access = useGyroAccess();
  const neutralRef = useRef<GyroTilt | null>(null);
  const candidateRef = useRef<GyroTilt | null>(null);

  const recalibrate = useCallback(() => {
    neutralRef.current = null;
    candidateRef.current = null;
  }, []);

  useEffect(() => {
    if (!control || !enabled || access !== "granted") return;
    const { id, mode, range } = control;
    const onEvent = (e: DeviceOrientationEvent) => {
      if (e.beta === null || e.gamma === null) return;
      const reading = { beta: e.beta, gamma: e.gamma };
      if (neutralRef.current === null) {
        const candidate = candidateRef.current;
        candidateRef.current = reading;
        if (!candidate || tiltAngleBetween(candidate, reading) > NEUTRAL_SETTLE_DEG)
          return;
        neutralRef.current = reading;
      }
      const axes = tiltToAxes(reading, neutralRef.current, screenAngle, range);
      // Tilt is continuous movement like a dragged stick: coalesced to ~30fps.
      setControl(id, gyroAxisValue(mode, axes), false);
    };
    window.addEventListener("deviceorientation", onEvent);
    return () => window.removeEventListener("deviceorientation", onEvent);
  }, [control, enabled, access, screenAngle, setControl]);

  return { access, recalibrate };
};
