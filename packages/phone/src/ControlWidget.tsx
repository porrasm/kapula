import type { KapulaInputValue } from "@kapula/protocol";
import { roundAxis } from "./axis-utils.js";
import { Dpad } from "./Dpad.js";
import { Joystick } from "./Joystick.js";
import { RawTouchSurface } from "./RawTouchSurface.js";
import type { ControlBox } from "./layout-override.js";
import type { ResolvedControl } from "./layout-utils.js";

type ControlWidgetProps = {
  resolved: ResolvedControl;
  disabled: boolean;
  /**
   * Draws the control at full strength but lets no pointer through — the
   * layout editor shows the real controls under its drag handles.
   */
  inert?: boolean;
  setControl: (id: string, value: KapulaInputValue, immediate: boolean) => void;
  /** Opens the text field of a `text` control (the live controller only). */
  onOpenText?: (controlId: string) => void;
};

/**
 * One on-screen control of a resolved layout, absolutely positioned in the
 * controller box: a joystick (by mode), a dpad, or a button. Shared by the
 * live controller and the layout editor so they can never drift apart.
 */
export const ControlWidget = ({
  resolved,
  disabled,
  inert = false,
  setControl,
  onOpenText,
}: ControlWidgetProps) => {
  const control = resolved.control;
  const inertClass = inert ? " pointer-events-none" : "";
  if (control.type === "joystick") {
    const mode = control.mode;
    return (
      <div
        className={`absolute${inertClass}`}
        style={controlBoxStyle(resolved)}
      >
        {mode === "dpad" ? (
          <Dpad
            size={resolved.width}
            label={control.label}
            testId={`control-${control.id}`}
            disabled={disabled}
            // Direction changes are edges like button presses: rare,
            // discrete, flushed immediately.
            onChange={(direction) => setControl(control.id, direction, true)}
          />
        ) : (
          <Joystick
            width={resolved.width}
            height={resolved.height}
            mode={mode}
            label={control.label}
            testId={`control-${control.id}`}
            disabled={disabled}
            onChange={(x, y, released) =>
              setControl(control.id, axisValue(mode, x, y), released)
            }
          />
        )}
      </div>
    );
  }
  if (control.type === "touchpad") {
    return (
      <div
        className={`absolute${inertClass}`}
        style={controlBoxStyle(resolved)}
      >
        <RawTouchSurface
          controlId={control.id}
          width={resolved.width}
          height={resolved.height}
          disabled={disabled}
          setControl={setControl}
          pad={{ label: control.label }}
        />
      </div>
    );
  }
  if (control.type === "text") {
    return (
      <button
        disabled={disabled}
        data-testid={`control-${control.id}`}
        className={`absolute ${control.shape === "rect" ? "rounded-xl" : "rounded-full"} bg-kp-bg-tertiary border-kp-border text-kp-text-primary font-bold leading-tight overflow-hidden disabled:opacity-40 ${buttonClasses(resolved)}${inertClass}`}
        style={{ ...controlBoxStyle(resolved), touchAction: "none" }}
        // A click, not a pointerdown: iOS opens the keyboard only for a
        // focus that happens inside a completed tap.
        onClick={() => onOpenText?.(control.id)}
        onContextMenu={(e) => e.preventDefault()}
        aria-label={control.label ?? "Type text"}
      >
        ⌨{control.label ? ` ${control.label}` : ""}
      </button>
    );
  }
  // The layout engine only places on-screen controls, so sensors never get
  // here; the narrowing is for the type system.
  if (control.type !== "button") return null;
  // "rect" squares off the corners — a circle under a thumb, a pill on the
  // shoulder / aux rows otherwise.
  const rounding = control.shape === "rect" ? "rounded-xl" : "rounded-full";
  return (
    <button
      disabled={disabled}
      data-testid={`control-${control.id}`}
      data-shape={control.shape ?? "round"}
      className={`absolute ${rounding} bg-kp-bg-tertiary border-kp-border text-kp-text-primary font-bold leading-tight overflow-hidden active:bg-kp-accent-primary active:text-kp-accent-on-primary disabled:opacity-40 ${buttonClasses(resolved)}${inertClass}`}
      style={{ ...controlBoxStyle(resolved), touchAction: "none" }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setControl(control.id, true, true);
      }}
      onPointerUp={() => setControl(control.id, false, true)}
      onPointerCancel={() => setControl(control.id, false, true)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {control.label}
    </button>
  );
};

/**
 * Single-axis sticks only send their own axis — half the frame payload;
 * "full" and "relative" both send the pair. Values are rounded here, the one
 * place every touch-stick frame passes through (see axis-utils.ts).
 */
const axisValue = (
  mode: "full" | "relative" | "x" | "y",
  rawX: number,
  rawY: number,
) => {
  const x = roundAxis(rawX);
  const y = roundAxis(rawY);
  return mode === "x" ? { x } : mode === "y" ? { y } : { x, y };
};

/** CSS box for a control: the engine hands out centers, CSS wants corners. */
export const controlBoxStyle = (box: ControlBox) => ({
  left: Math.round(box.x - box.width / 2),
  top: Math.round(box.y - box.height / 2),
  width: Math.round(box.width),
  height: Math.round(box.height),
});

const buttonClasses = (resolved: ResolvedControl): string => {
  if (resolved.role === "shoulder") return "border-2 text-sm";
  if (resolved.role === "aux") return "border text-xs text-kp-text-secondary";
  const control = resolved.control;
  const label =
    control.type === "button"
      ? control.label
      : control.type === "text"
        ? `⌨ ${control.label ?? ""}`.trim()
        : "";
  return label.length > 3 ? "border-2 text-sm px-1" : "border-2 text-lg";
};
