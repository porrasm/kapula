import { useEffect, useRef, useState } from "react";
import type { KapulaInputValue } from "@kapula/protocol";
import {
  diffPhysicalControls,
  IDLE_PHYSICAL_GAMEPAD,
  pickGamepad,
  readPhysicalGamepad,
  samePhysicalControls,
} from "./physical-gamepad-utils.js";

/** What the panel shows about the controller currently read. */
export type PhysicalGamepadStatus = {
  /** False when the browser has no Gamepad API at all. */
  supported: boolean;
  /** The controller's reported name, null while none is detected. */
  id: string | null;
  /** Whether the controller reports the W3C "standard" button layout. */
  standardMapping: boolean;
  /** Latest mapped state, for the on-screen preview. */
  controls: Record<string, KapulaInputValue>;
};

/** Gamepad API present in this browser (the picker gates on it too). */
export const isPhysicalGamepadSupported = (): boolean =>
  typeof navigator !== "undefined" &&
  typeof navigator.getGamepads === "function";

/** Some embeddings throw on getGamepads (permissions policy); read as none. */
const currentGamepads = (): (Gamepad | null)[] => {
  try {
    return Array.from(navigator.getGamepads());
  } catch {
    return [];
  }
};

/**
 * Buzzes the paired controller, for the driver's `{ vibrateMs }` convention
 * while the player is bridging a real gamepad — the phone's own
 * `navigator.vibrate` shakes a device nobody is holding.
 *
 * Haptics are best-effort by nature: the actuator is missing on many pads and
 * on Safari, `playEffect` rejects while another effect is running, and some
 * browsers require a user gesture. A failure is never worth surfacing.
 */
export const rumblePhysicalGamepad = (durationMs: number): void => {
  const gamepad = pickGamepad(currentGamepads());
  const actuator = gamepad?.vibrationActuator;
  if (!actuator?.playEffect) return;
  try {
    void actuator
      .playEffect("dual-rumble", {
        duration: durationMs,
        strongMagnitude: 1,
        weakMagnitude: 1,
      })
      .catch(() => {
        /* ignore */
      });
  } catch {
    /* ignore */
  }
};

/**
 * Reads a paired controller through the Gamepad API and feeds the mapped
 * state into the input sender: each animation frame the controller is
 * polled (the API is poll-only — `gamepadconnected` fires, but values never
 * push), the reading is mapped onto the fixed physical control set, and
 * only the controls that changed are set — button edges immediately, stick
 * and trigger movement throttled like touch sticks. A resting controller
 * therefore sends nothing at all.
 *
 * Browsers hide controllers until a button is pressed (a fingerprinting
 * guard), so "nothing detected" is normal right after pairing; the panel
 * tells the player to press a button. Losing the controller mid-game reads
 * as everything released, so a dropped Bluetooth link never leaves a stick
 * pinned on the driver's side.
 */
export const usePhysicalGamepad = (params: {
  /** False while input must not be sent (menu open, paused, trial). */
  enabled: boolean;
  setControl: (id: string, value: KapulaInputValue, immediate: boolean) => void;
}): PhysicalGamepadStatus => {
  const { enabled, setControl } = params;
  const supported = isPhysicalGamepadSupported();
  const [status, setStatus] = useState<PhysicalGamepadStatus>({
    supported,
    id: null,
    standardMapping: true,
    controls: IDLE_PHYSICAL_GAMEPAD,
  });
  const setControlRef = useRef(setControl);
  setControlRef.current = setControl;

  useEffect(() => {
    if (!supported) return;
    let frame = 0;
    let lastId: string | null = null;
    let lastMapping = true;
    let lastControls = IDLE_PHYSICAL_GAMEPAD;
    // What the input sender holds; sends are diffs against it. Null until
    // the first poll: the sender may still hold what an earlier run of this
    // effect left there (a button held when the menu opened), so the first
    // push writes every control — as one coalesced frame, not 16 edges.
    let sent: Record<string, KapulaInputValue> | null = null;

    const push = (next: Record<string, KapulaInputValue>) => {
      const first = sent === null;
      const changed = diffPhysicalControls(sent ?? {}, next);
      // Movement first, so a press and the stick it rode in on share a frame.
      for (const id of changed.throttled) {
        setControlRef.current(id, next[id]!, false);
      }
      for (const id of changed.immediate) {
        setControlRef.current(id, next[id]!, !first);
      }
      sent = next;
    };

    const poll = () => {
      frame = window.requestAnimationFrame(poll);
      const gamepad = pickGamepad(currentGamepads());
      const controls = gamepad
        ? readPhysicalGamepad(gamepad)
        : IDLE_PHYSICAL_GAMEPAD;
      // While inert the sender is disabled (nothing reaches the driver), but
      // its state is returned to rest so that re-enabling sends the real
      // state as a diff against idle instead of against a stale hold.
      push(enabled ? controls : IDLE_PHYSICAL_GAMEPAD);

      const id = gamepad?.id ?? null;
      const mapping = gamepad ? gamepad.mapping === "standard" : true;
      // A React state write per frame would re-render at 60 Hz; publish
      // only when something visible changed.
      if (
        id === lastId &&
        mapping === lastMapping &&
        samePhysicalControls(lastControls, controls)
      ) {
        return;
      }
      lastId = id;
      lastMapping = mapping;
      lastControls = controls;
      setStatus({ supported, id, standardMapping: mapping, controls });
    };
    frame = window.requestAnimationFrame(poll);
    return () => window.cancelAnimationFrame(frame);
  }, [supported, enabled]);

  return status;
};
