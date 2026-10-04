import type { ControlSchema } from "@kapula/protocol";

/**
 * Conventions for the driver → player `message` relay. The server never looks
 * inside the payload (it is an opaque relay by design), so these are pure
 * client-side conventions a driver opts into by sending the right shape;
 * anything else is delivered and ignored.
 *
 * - `{ vibrateMs: number }` — buzz the phone, and the controller too when the
 *   player is bridging a real gamepad.
 * - `{ text: string }` — show a line in the in-game header for a few seconds
 *   ("You are Red", a score, "Press A to respawn"). `{ text: null }` clears
 *   it at once. Longer text is truncated rather than dropped: a driver that
 *   sends a paragraph should still see something useful on the phone.
 * - `{ set: { [controlId]: value } }` — set a control's displayed state
 *   without emitting input (the driver already knows): a number for faders,
 *   knobs and single-axis sticks, `{x, y}` for sticks, a boolean for toggle
 *   buttons. Bad entries are ignored one by one.
 * - `{ labels: { [controlId]: string } }` — replace a control's label (max
 *   16 chars, truncated); an empty string restores the schema's label.
 */
export const DRIVER_TEXT_MAX_LENGTH = 64;
/** How long a text line stays up when the driver does not clear it. */
export const DRIVER_TEXT_MS = 4000;
/** Guards against a stuck motor; the browser caps this anyway. */
export const DRIVER_VIBRATE_MAX_MS = 1000;

/** Longest label a driver may put on a control. */
export const DRIVER_LABEL_MAX_LENGTH = 16;

/** A value a driver may push into a control with `set`. */
export type DriverSetValue = number | boolean | { x?: number; y?: number };

export type DriverPayload = {
  /** Milliseconds to buzz, already clamped; null when not requested. */
  vibrateMs: number | null;
  /** A string to show, null to clear, undefined when the key is absent. */
  text: string | null | undefined;
  /** Well-shaped `set` entries by control id; empty when none. */
  set: Record<string, DriverSetValue>;
  /** `labels` entries by control id, truncated; "" restores the schema's. */
  labels: Record<string, string>;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const parseSetValue = (v: unknown): DriverSetValue | undefined => {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (!isRecord(v)) return undefined;
  const out: { x?: number; y?: number } = {};
  for (const axis of ["x", "y"] as const) {
    const a = v[axis];
    if (a === undefined) continue;
    if (typeof a !== "number" || !Number.isFinite(a)) return undefined;
    out[axis] = a;
  }
  return out.x === undefined && out.y === undefined ? undefined : out;
};

export const parseDriverPayload = (payload: unknown): DriverPayload => {
  const source = (isRecord(payload) ? payload : {}) as {
    vibrateMs?: unknown;
    text?: unknown;
    set?: unknown;
    labels?: unknown;
  };
  const vibrateMs =
    typeof source.vibrateMs === "number" && Number.isFinite(source.vibrateMs)
      ? Math.min(Math.max(0, Math.round(source.vibrateMs)), DRIVER_VIBRATE_MAX_MS)
      : null;

  let text: string | null | undefined;
  if (source.text === null) {
    text = null;
  } else if (typeof source.text === "string") {
    const trimmed = source.text.trim().slice(0, DRIVER_TEXT_MAX_LENGTH);
    // An empty or whitespace-only string reads as "clear", not as a blank
    // line the player has to wait out.
    text = trimmed === "" ? null : trimmed;
  }

  const set: Record<string, DriverSetValue> = {};
  if (isRecord(source.set)) {
    for (const [id, raw] of Object.entries(source.set)) {
      const value = parseSetValue(raw);
      if (value !== undefined) set[id] = value;
    }
  }
  const labels: Record<string, string> = {};
  if (isRecord(source.labels)) {
    for (const [id, raw] of Object.entries(source.labels)) {
      if (typeof raw === "string") {
        labels[id] = raw.slice(0, DRIVER_LABEL_MAX_LENGTH);
      }
    }
  }
  return { vibrateMs, text, set, labels };
};

/** A pushed value; `rev` changes on every push so the same value re-applies. */
export type ControlValueOverride = { value: DriverSetValue; rev: number };

export type ControlOverrides = {
  values: Record<string, ControlValueOverride>;
  labels: Record<string, string>;
};

export const NO_OVERRIDES: ControlOverrides = { values: {}, labels: {} };

const setValueFits = (
  control: ControlSchema["controls"][number],
  value: DriverSetValue,
): boolean => {
  switch (control.type) {
    case "fader":
    case "knob":
      return typeof value === "number";
    case "button":
      return control.mode === "toggle" && typeof value === "boolean";
    case "joystick":
      if (control.mode === "dpad" || control.mode === "relative") return false;
      if (control.mode === "x" || control.mode === "y") {
        if (typeof value === "number") return true;
      }
      return typeof value === "object";
    default:
      return false;
  }
};

const LABELLED = new Set(["button", "fader", "knob", "text", "touchpad", "joystick"]);

/**
 * Folds a parsed payload into the overrides for `schema`: unknown ids and
 * values that do not fit the control are dropped per entry. Pure, and it
 * never sends anything — `set` changes what is shown, not what is reported.
 */
export const applyDriverOverrides = (
  prev: ControlOverrides,
  parsed: Pick<DriverPayload, "set" | "labels">,
  schema: ControlSchema,
  rev: number,
): ControlOverrides => {
  const byId = new Map(schema.controls.map((c) => [c.id, c]));
  let values = prev.values;
  let labels = prev.labels;
  for (const [id, value] of Object.entries(parsed.set)) {
    const control = byId.get(id);
    if (!control || !setValueFits(control, value)) continue;
    values = { ...values, [id]: { value, rev } };
  }
  for (const [id, label] of Object.entries(parsed.labels)) {
    const control = byId.get(id);
    if (!control || !LABELLED.has(control.type)) continue;
    if (label === "") {
      if (!(id in labels)) continue;
      const { [id]: _removed, ...rest } = labels;
      labels = rest;
    } else {
      labels = { ...labels, [id]: label };
    }
  }
  return values === prev.values && labels === prev.labels
    ? prev
    : { values, labels };
};
