import {
  PHYSICAL_GAMEPAD_CONTROLS,
  PHYSICAL_GAMEPAD_DPAD_BUTTONS,
  type KapulaDpadDirection,
  type KapulaInputValue,
} from "@kapula/protocol";
import { roundAxis } from "./axis-utils.js";

/**
 * Pure mapping from a Gamepad API reading onto the protocol's fixed
 * physical-gamepad control set (`PHYSICAL_GAMEPAD_CONTROLS` in common). Kept
 * free of the DOM so the unit tests can feed it synthetic readings; the
 * polling loop and connection events live in usePhysicalGamepad.ts.
 */

/** The slice of a `Gamepad` the mapping reads — a plain shape for tests. */
export type GamepadReading = {
  buttons: readonly { pressed: boolean; value: number }[];
  axes: readonly number[];
};

/**
 * Sticks at rest wobble by a few percent; below this radius the stick
 * reads as centered so a resting controller sends nothing. The remaining
 * travel is rescaled so full deflection is still 1.
 */
export const STICK_DEADZONE = 0.1;

const clampAxis = (v: number): number =>
  Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;

/** Applies the radial deadzone with rescaling and clamps to the unit circle. */
export const applyStickDeadzone = (
  x: number,
  y: number,
): { x: number; y: number } => {
  const cx = clampAxis(x);
  const cy = clampAxis(y);
  const magnitude = Math.hypot(cx, cy);
  if (magnitude <= STICK_DEADZONE) return { x: 0, y: 0 };
  const scaled = Math.min(1, (magnitude - STICK_DEADZONE) / (1 - STICK_DEADZONE));
  const factor = scaled / magnitude;
  return { x: roundAxis(cx * factor), y: roundAxis(cy * factor) };
};

const pressed = (reading: GamepadReading, index: number): boolean =>
  reading.buttons[index]?.pressed === true;

/** Folds the four standard-mapping dpad buttons into one direction code. */
export const dpadDirection = (reading: GamepadReading): KapulaDpadDirection => {
  const up = pressed(reading, PHYSICAL_GAMEPAD_DPAD_BUTTONS.up);
  const down = pressed(reading, PHYSICAL_GAMEPAD_DPAD_BUTTONS.down);
  const left = pressed(reading, PHYSICAL_GAMEPAD_DPAD_BUTTONS.left);
  const right = pressed(reading, PHYSICAL_GAMEPAD_DPAD_BUTTONS.right);
  // Opposite buttons cancel out, like a real hat switch.
  const v = up === down ? "" : up ? "u" : "d";
  const h = left === right ? "" : left ? "l" : "r";
  return ((v + h) || "c") as KapulaDpadDirection;
};

/** A trigger's analog pull in [0, 1]; digital-only triggers read 0 or 1. */
const triggerValue = (reading: GamepadReading, index: number): number => {
  const button = reading.buttons[index];
  if (!button) return 0;
  const value = Number.isFinite(button.value) ? button.value : 0;
  if (value <= 0 && button.pressed) return 1;
  return roundAxis(Math.max(0, Math.min(1, value)));
};

/**
 * The full control state for one reading: every id in
 * `PHYSICAL_GAMEPAD_CONTROLS` is present, so a driver receives the same
 * keys in every frame (missing hardware reads as released / centered).
 */
export const readPhysicalGamepad = (
  reading: GamepadReading,
): Record<string, KapulaInputValue> => {
  const controls: Record<string, KapulaInputValue> = {};
  for (const control of PHYSICAL_GAMEPAD_CONTROLS) {
    switch (control.kind) {
      case "stick": {
        const [ix, iy] = control.axisIndices ?? [0, 1];
        controls[control.id] = applyStickDeadzone(
          reading.axes[ix] ?? 0,
          reading.axes[iy] ?? 0,
        );
        break;
      }
      case "dpad":
        controls[control.id] = dpadDirection(reading);
        break;
      case "button":
        controls[control.id] = pressed(reading, control.buttonIndex ?? -1);
        break;
      case "trigger":
        controls[control.id] = triggerValue(reading, control.buttonIndex ?? -1);
        break;
    }
  }
  return controls;
};

/** Everything a controller reads when it is unplugged or not yet touched. */
export const IDLE_PHYSICAL_GAMEPAD: Record<string, KapulaInputValue> =
  readPhysicalGamepad({ buttons: [], axes: [] });

const sameValue = (a: KapulaInputValue, b: KapulaInputValue): boolean => {
  if (typeof a !== "object" || typeof b !== "object") return a === b;
  const ax = "x" in a ? a.x : undefined;
  const bx = "x" in b ? b.x : undefined;
  const ay = "y" in a ? a.y : undefined;
  const by = "y" in b ? b.y : undefined;
  return ax === bx && ay === by;
};

/** True when two mapped states would produce identical input frames. */
export const samePhysicalControls = (
  a: Record<string, KapulaInputValue>,
  b: Record<string, KapulaInputValue>,
): boolean =>
  PHYSICAL_GAMEPAD_CONTROLS.every((control) => {
    const x = a[control.id];
    const y = b[control.id];
    return x !== undefined && y !== undefined && sameValue(x, y);
  });

/**
 * Which controls changed between two readings, split by how the change
 * should be sent: button presses and dpad direction changes are edges that
 * flush immediately; stick and trigger movement rides the ~30 fps throttle.
 */
export const diffPhysicalControls = (
  prev: Record<string, KapulaInputValue>,
  next: Record<string, KapulaInputValue>,
): { immediate: string[]; throttled: string[] } => {
  const immediate: string[] = [];
  const throttled: string[] = [];
  for (const control of PHYSICAL_GAMEPAD_CONTROLS) {
    const before = prev[control.id];
    const after = next[control.id];
    if (after === undefined) continue;
    if (before !== undefined && sameValue(before, after)) continue;
    if (control.kind === "button" || control.kind === "dpad") {
      immediate.push(control.id);
    } else {
      throttled.push(control.id);
    }
  }
  return { immediate, throttled };
};

/**
 * Picks the controller to read: the first connected one, preferring a
 * standard-mapping controller when several are paired.
 */
export const pickGamepad = <T extends { mapping: string } | null>(
  gamepads: readonly T[],
): T | null => {
  const connected = gamepads.filter((g): g is NonNullable<T> => g !== null);
  return (
    connected.find((g) => g.mapping === "standard") ?? connected[0] ?? null
  );
};
