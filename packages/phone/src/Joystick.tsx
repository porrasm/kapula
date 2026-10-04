import { useRef, useState } from "react";
import { relativeStickTravel, relativeStickValue } from "./layout-utils.js";
import { pointerDeltaInFrame } from "./pointer-utils.js";
import { stickReleaseValue } from "./control-state.js";
import { useContentFrame } from "./OrientedSurface.js";

type JoystickProps = {
  /** Pad box in px; full mode is a circle (width === height), single-axis
   * modes render a pill track along their axis, relative mode a square. */
  width: number;
  height: number;
  /** "full" reports both axes; "x"/"y" constrain the knob to one axis;
   * "relative" reports both axes measured from wherever the touch landed. */
  mode: "full" | "relative" | "x" | "y";
  /** Default true; false keeps the value on release (see the protocol). */
  spring?: boolean;
  label?: string;
  testId?: string;
  disabled: boolean;
  /** Normalized position: x right-positive, y down-positive, both in [-1, 1].
   * The unused axis of a single-axis stick stays 0. */
  onChange: (x: number, y: number, released: boolean) => void;
};

export const Joystick = ({
  width,
  height,
  mode,
  spring = true,
  label,
  testId,
  disabled,
  onChange,
}: JoystickProps) => {
  const padRef = useRef<HTMLDivElement | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  // Relative mode only: where this touch landed, as an offset from the pad's
  // center — the neutral point the drag is measured from. A ref as well as
  // state because the first value is needed inside the same pointerdown.
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  // Value (as px offset) held from the last release of a non-spring stick, and
  // where the current touch landed, so the drag continues from the hold.
  const offsetRef = useRef({ x: 0, y: 0 });
  const anchorRef = useRef({ x: 0, y: 0 });
  const lastValueRef = useRef({ x: 0, y: 0 });
  const { synthetic } = useContentFrame();

  const relative = mode === "relative";
  const travel = relativeStickTravel(width, height);
  const knobSize = relative
    ? Math.round(Math.min(width, height) * 0.3)
    : mode === "full"
      ? Math.round(Math.min(width, height) * 0.4)
      : Math.round(Math.min(width, height) * 0.72);
  const maxX = mode === "y" ? 0 : (width - knobSize) / 2;
  const maxY = mode === "x" ? 0 : (height - knobSize) / 2;

  // Client coordinates → the pad's own: the surface may be rotated (and the
  // help demo scaled) between the two.
  const padDelta = (clientX: number, clientY: number) => {
    const pad = padRef.current;
    if (!pad) return null;
    return pointerDeltaInFrame(
      pad.getBoundingClientRect(),
      { width, height },
      synthetic,
      clientX,
      clientY,
    );
  };

  const updateFromPointer = (clientX: number, clientY: number) => {
    const delta = padDelta(clientX, clientY);
    if (!delta) return;
    let dx = delta.dx - anchorRef.current.x;
    let dy = delta.dy - anchorRef.current.y;
    if (relative) {
      dx = delta.dx;
      dy = delta.dy;
      // Measured from the touch-down point, not the pad's center, and never
      // clamped to the pad: a drag that leaves the box keeps steering (the
      // pointer is captured) until the finger lifts.
      const from = originRef.current ?? { x: dx, y: dy };
      const value = relativeStickValue(dx - from.x, dy - from.y, travel);
      offsetRef.current = { x: value.dx, y: value.dy };
      lastValueRef.current = { x: value.x, y: value.y };
      setOffset(offsetRef.current);
      onChange(value.x, value.y, false);
      return;
    }
    if (mode === "full") {
      const distance = Math.hypot(dx, dy);
      if (distance > maxX) {
        dx = (dx / distance) * maxX;
        dy = (dy / distance) * maxX;
      }
    } else {
      dx = Math.max(-maxX, Math.min(maxX, dx));
      dy = Math.max(-maxY, Math.min(maxY, dy));
    }
    offsetRef.current = { x: dx, y: dy };
    lastValueRef.current = {
      x: maxX > 0 ? dx / maxX : 0,
      y: maxY > 0 ? dy / maxY : 0,
    };
    setOffset(offsetRef.current);
    onChange(lastValueRef.current.x, lastValueRef.current.y, false);
  };

  const padDeltaX = (cx: number, cy: number) => padDelta(cx, cy)?.dx ?? 0;
  const padDeltaY = (cx: number, cy: number) => padDelta(cx, cy)?.dy ?? 0;

  const press = (clientX: number, clientY: number) => {
    if (relative) {
      const delta = padDelta(clientX, clientY);
      if (!delta) return;
      // A held (non-spring) value shifts the origin so the drag continues
      // from it instead of from neutral.
      originRef.current = {
        x: delta.dx - offsetRef.current.x,
        y: delta.dy - offsetRef.current.y,
      };
      setOrigin(originRef.current);
    } else {
      anchorRef.current = {
        x: padDeltaX(clientX, clientY) - offsetRef.current.x,
        y: padDeltaY(clientX, clientY) - offsetRef.current.y,
      };
    }
    updateFromPointer(clientX, clientY);
  };

  const release = () => {
    pointerIdRef.current = null;
    const value = stickReleaseValue(spring, lastValueRef.current);
    if (spring) {
      originRef.current = null;
      setOrigin(null);
      offsetRef.current = { x: 0, y: 0 };
      lastValueRef.current = { x: 0, y: 0 };
      setOffset(offsetRef.current);
    }
    // Without spring the knob stays drawn (and the origin ring) where it is.
    onChange(value.x, value.y, true);
  };

  // A relative pad has no home position, so the released knob sits in the
  // middle only as a resting hint — faded, inside the throw ring it will get
  // wherever the next touch lands.
  const idleRelative = relative && origin === null;

  return (
    <div
      ref={padRef}
      data-testid={testId}
      data-mode={mode}
      className={`relative bg-kp-bg-tertiary border border-kp-border select-none ${
        relative ? "rounded-2xl" : "rounded-full"
      } ${disabled ? "opacity-40" : ""}`}
      style={{ width, height, touchAction: "none" }}
      onPointerDown={(e) => {
        if (disabled || pointerIdRef.current !== null) return;
        pointerIdRef.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
        press(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (e.pointerId !== pointerIdRef.current) return;
        updateFromPointer(e.clientX, e.clientY);
      }}
      onPointerUp={(e) => {
        if (e.pointerId === pointerIdRef.current) release();
      }}
      onPointerCancel={(e) => {
        if (e.pointerId === pointerIdRef.current) release();
      }}
    >
      {relative && (
        <div
          className={`absolute rounded-full border pointer-events-none ${
            idleRelative
              ? "border-dashed border-kp-border opacity-60"
              : "border-kp-accent-primary/50"
          }`}
          style={{
            width: travel * 2,
            height: travel * 2,
            left: width / 2 + (origin?.x ?? 0) - travel,
            top: height / 2 + (origin?.y ?? 0) - travel,
          }}
        />
      )}
      <div
        className={`absolute rounded-full bg-kp-accent-primary shadow-kp-card ${
          idleRelative ? "opacity-50" : ""
        }`}
        style={{
          width: knobSize,
          height: knobSize,
          left: (width - knobSize) / 2 + (origin?.x ?? 0) + offset.x,
          top: (height - knobSize) / 2 + (origin?.y ?? 0) + offset.y,
        }}
      />
      {label && (
        <span
          className={`absolute text-[10px] text-kp-text-secondary uppercase tracking-wide pointer-events-none ${
            mode === "y"
              ? "top-1 left-1/2 -translate-x-1/2"
              : "bottom-1 left-1/2 -translate-x-1/2"
          }`}
        >
          {label}
        </span>
      )}
    </div>
  );
};
