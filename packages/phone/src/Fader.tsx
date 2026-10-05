import { useEffect, useRef, useState } from "react";
import {
  faderAxisDelta,
  faderReleaseValue,
  faderValueFromDelta,
} from "./fader-utils.js";
import { registerTap, scaleDragDelta, type TapPoint } from "./gesture-utils.js";
import { pointerDeltaInFrame } from "./pointer-utils.js";
import { useContentFrame } from "./OrientedSurface.js";

type FaderProps = {
  width: number;
  height: number;
  axis: "v" | "h";
  /** Return to `defaultValue` on release (and send it). */
  spring: boolean;
  defaultValue: number;
  label?: string;
  /** A driver-pushed value: shown and held, never reported. */
  external?: { value: number; rev: number };
  testId?: string;
  disabled: boolean;
  /** A second finger is down on the controller: drags move at a tenth. */
  fineMode?: boolean;
  /** Value in [0, 1]; `released` flushes immediately. Also called once on
   * mount with the default. */
  onChange: (value: number, released: boolean) => void;
};

export const Fader = ({
  width,
  height,
  axis,
  spring,
  defaultValue,
  label,
  external,
  testId,
  disabled,
  fineMode = false,
  onChange,
}: FaderProps) => {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const [value, setValue] = useState(defaultValue);
  const valueRef = useRef(defaultValue);
  const startRef = useRef<{
    value: number;
    dx: number;
    dy: number;
    fine: boolean;
  } | null>(null);
  const fineRef = useRef(fineMode);
  fineRef.current = fineMode;
  const lastTapRef = useRef<TapPoint | null>(null);
  const { synthetic } = useContentFrame();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // The initial frame reports the default.
  useEffect(() => {
    onChangeRef.current(defaultValue, false);
  }, [defaultValue]);

  // The driver already knows this value, so nothing is sent for it.
  useEffect(() => {
    if (!external) return;
    const next = Math.min(1, Math.max(0, external.value));
    valueRef.current = next;
    setValue(next);
  }, [external?.rev]);

  const vertical = axis === "v";
  const length = vertical ? height : width;
  const capThickness = Math.round((vertical ? width : height) * 0.9);
  const capLength = Math.max(16, Math.round(capThickness * 0.7));
  const travel = Math.max(0, length - capLength);

  const delta = (clientX: number, clientY: number) => {
    const track = trackRef.current;
    if (!track) return null;
    return pointerDeltaInFrame(
      track.getBoundingClientRect(),
      { width, height },
      synthetic,
      clientX,
      clientY,
    );
  };

  const set = (next: number, released: boolean) => {
    valueRef.current = next;
    setValue(next);
    onChange(next, released);
  };

  const release = () => {
    pointerIdRef.current = null;
    startRef.current = null;
    set(faderReleaseValue(spring, defaultValue, valueRef.current), true);
  };

  const capOffset = value * travel;
  const fillLength = capOffset + capLength / 2;

  return (
    <div
      ref={trackRef}
      data-testid={testId}
      data-axis={axis}
      data-value={value}
      role="slider"
      aria-label={label}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Number(value.toFixed(3))}
      className={`relative bg-kp-bg-tertiary border border-kp-border rounded-2xl select-none overflow-hidden ${
        disabled ? "opacity-40" : ""
      }`}
      style={{ width, height, touchAction: "none" }}
      onPointerDown={(e) => {
        if (disabled || pointerIdRef.current !== null) return;
        const d = delta(e.clientX, e.clientY);
        if (!d) return;
        pointerIdRef.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
        startRef.current = {
          value: valueRef.current,
          dx: d.dx,
          dy: d.dy,
          fine: fineRef.current,
        };
      }}
      onPointerMove={(e) => {
        if (e.pointerId !== pointerIdRef.current || !startRef.current) return;
        const d = delta(e.clientX, e.clientY);
        if (!d) return;
        // Entering or leaving fine mode re-anchors the drag here, so the
        // cap does not jump.
        if (startRef.current.fine !== fineRef.current) {
          startRef.current = {
            value: valueRef.current,
            dx: d.dx,
            dy: d.dy,
            fine: fineRef.current,
          };
        }
        const start = startRef.current;
        set(
          faderValueFromDelta(
            start.value,
            scaleDragDelta(faderAxisDelta(axis, start, d), start.fine),
            travel,
          ),
          false,
        );
      }}
      onPointerUp={(e) => {
        if (e.pointerId !== pointerIdRef.current) return;
        const tap = registerTap(lastTapRef.current, {
          time: e.timeStamp,
          x: e.clientX,
          y: e.clientY,
        });
        lastTapRef.current = tap.last;
        if (!tap.double) return release();
        pointerIdRef.current = null;
        startRef.current = null;
        set(defaultValue, true);
      }}
      onPointerCancel={(e) => {
        if (e.pointerId === pointerIdRef.current) release();
      }}
    >
      <div
        className="absolute bg-kp-accent-primary/30 pointer-events-none"
        style={
          vertical
            ? { left: 0, right: 0, bottom: 0, height: fillLength }
            : { left: 0, top: 0, bottom: 0, width: fillLength }
        }
      />
      <div
        className="absolute rounded-lg bg-kp-accent-primary shadow-kp-card pointer-events-none"
        style={
          vertical
            ? {
                width: capThickness,
                height: capLength,
                left: (width - capThickness) / 2,
                bottom: capOffset,
              }
            : {
                width: capLength,
                height: capThickness,
                top: (height - capThickness) / 2,
                left: capOffset,
              }
        }
      />
      {label && (
        <span className="absolute top-1 left-1/2 -translate-x-1/2 text-[10px] text-kp-text-secondary uppercase tracking-wide pointer-events-none">
          {label}
        </span>
      )}
    </div>
  );
};
