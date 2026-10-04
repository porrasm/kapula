import { useEffect, useRef, useState } from "react";
import {
  KNOB_ARC_DEGREES,
  clampKnob,
  knobAngle,
  knobDragDelta,
  knobTurnsFromDelta,
  knobValueFromDelta,
} from "./knob-utils.js";
import { registerTap, scaleDragDelta, type TapPoint } from "./gesture-utils.js";
import { pointerDeltaInFrame } from "./pointer-utils.js";
import { useContentFrame } from "./OrientedSurface.js";

type KnobProps = {
  /** Square box in px. */
  size: number;
  mode: "absolute" | "endless";
  defaultValue: number;
  label?: string;
  /** A driver-pushed value: shown and held, never reported. */
  external?: { value: number; rev: number };
  testId?: string;
  disabled: boolean;
  /** A second finger is down on the controller: drags move at a tenth. */
  fineMode?: boolean;
  /** Absolute: value in [0, 1]. Endless: cumulative turns. `released`
   * flushes immediately. Also called once on mount (default / 0). */
  onChange: (value: number, released: boolean) => void;
};

/** Point on a circle, degrees clockwise from 12 o'clock. */
const polar = (c: number, r: number, deg: number) => {
  const a = (deg * Math.PI) / 180;
  return { x: c + r * Math.sin(a), y: c - r * Math.cos(a) };
};

export const Knob = ({
  size,
  mode,
  defaultValue,
  label,
  external,
  testId,
  disabled,
  fineMode = false,
  onChange,
}: KnobProps) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const endless = mode === "endless";
  const initial = endless ? 0 : defaultValue;
  const [value, setValue] = useState(initial);
  const valueRef = useRef(initial);
  const startRef = useRef<{
    value: number;
    dy: number;
    fine: boolean;
  } | null>(null);
  const fineRef = useRef(fineMode);
  fineRef.current = fineMode;
  const lastTapRef = useRef<TapPoint | null>(null);
  const { synthetic } = useContentFrame();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    onChangeRef.current(initial, false);
  }, [initial]);

  useEffect(() => {
    if (!external) return;
    const next = endless ? external.value : clampKnob(external.value);
    valueRef.current = next;
    setValue(next);
  }, [external?.rev]);

  const dy = (clientX: number, clientY: number) => {
    const el = ref.current;
    if (!el) return null;
    return pointerDeltaInFrame(
      el.getBoundingClientRect(),
      { width: size, height: size },
      synthetic,
      clientX,
      clientY,
    ).dy;
  };

  const set = (next: number, released: boolean) => {
    valueRef.current = next;
    setValue(next);
    onChange(next, released);
  };

  const c = size / 2;
  const r = size * 0.42;
  const startDeg = -KNOB_ARC_DEGREES / 2;
  const angle = endless ? value * 360 : knobAngle(value);
  const arcEnd = polar(c, r, KNOB_ARC_DEGREES / 2);
  const arcStart = polar(c, r, startDeg);
  const cur = polar(c, r, angle);
  const tip = polar(c, r * 0.9, angle);
  const inner = polar(c, r * 0.35, angle);
  const track = `M ${arcStart.x} ${arcStart.y} A ${r} ${r} 0 1 1 ${arcEnd.x} ${arcEnd.y}`;
  const fraction = clampKnob(value);
  const filled =
    !endless && fraction > 0
      ? `M ${arcStart.x} ${arcStart.y} A ${r} ${r} 0 ${
          fraction * KNOB_ARC_DEGREES > 180 ? 1 : 0
        } 1 ${cur.x} ${cur.y}`
      : null;

  return (
    <div
      ref={ref}
      data-testid={testId}
      data-mode={mode}
      data-value={value}
      className={`relative rounded-full select-none ${
        disabled ? "opacity-40" : ""
      }`}
      style={{ width: size, height: size, touchAction: "none" }}
      onPointerDown={(e) => {
        if (disabled || pointerIdRef.current !== null) return;
        const y = dy(e.clientX, e.clientY);
        if (y === null) return;
        pointerIdRef.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
        startRef.current = {
          value: valueRef.current,
          dy: y,
          fine: fineRef.current,
        };
      }}
      onPointerMove={(e) => {
        if (e.pointerId !== pointerIdRef.current || !startRef.current) return;
        const y = dy(e.clientX, e.clientY);
        if (y === null) return;
        // Entering or leaving fine mode re-anchors the drag here.
        if (startRef.current.fine !== fineRef.current) {
          startRef.current = {
            value: valueRef.current,
            dy: y,
            fine: fineRef.current,
          };
        }
        const start = startRef.current;
        const delta = scaleDragDelta(knobDragDelta(start.dy, y), start.fine);
        set(
          endless
            ? knobTurnsFromDelta(start.value, delta)
            : knobValueFromDelta(start.value, delta),
          false,
        );
      }}
      onPointerUp={(e) => {
        if (e.pointerId !== pointerIdRef.current) return;
        pointerIdRef.current = null;
        startRef.current = null;
        const tap = registerTap(lastTapRef.current, {
          time: e.timeStamp,
          x: e.clientX,
          y: e.clientY,
        });
        lastTapRef.current = tap.last;
        set(tap.double ? initial : valueRef.current, true);
      }}
      onPointerCancel={(e) => {
        if (e.pointerId !== pointerIdRef.current) return;
        pointerIdRef.current = null;
        startRef.current = null;
        set(valueRef.current, true);
      }}
    >
      <div className="absolute inset-0 rounded-full bg-kp-bg-tertiary border border-kp-border" />
      <svg
        className="absolute inset-0 pointer-events-none"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
      >
        <path
          d={track}
          fill="none"
          strokeWidth={4}
          strokeLinecap="round"
          className="stroke-kp-border"
        />
        {filled && (
          <path
            d={filled}
            fill="none"
            strokeWidth={4}
            strokeLinecap="round"
            className="stroke-kp-accent-primary"
          />
        )}
        <line
          x1={inner.x}
          y1={inner.y}
          x2={tip.x}
          y2={tip.y}
          strokeWidth={3}
          strokeLinecap="round"
          className="stroke-kp-accent-primary"
        />
      </svg>
      {!endless && (
        <span
          data-testid={testId ? `${testId}-value` : undefined}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[11px] text-kp-text-secondary pointer-events-none"
        >
          {value.toFixed(2)}
        </span>
      )}
      {label && (
        <span className="absolute bottom-1 left-1/2 -translate-x-1/2 text-[10px] text-kp-text-secondary uppercase tracking-wide pointer-events-none">
          {label}
        </span>
      )}
    </div>
  );
};
