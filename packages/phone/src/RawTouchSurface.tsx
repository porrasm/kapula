import { useEffect, useRef, useState } from "react";
import type { KapulaInputValue, KapulaRawTouch } from "@kapula/protocol";
import { useContentFrame } from "./OrientedSurface.js";
import { pointerDeltaInFrame } from "./pointer-utils.js";
import {
  allocateTouchSlot,
  touchesValue,
  touchPosition,
} from "./raw-touch-utils.js";

type RawTouchSurfaceProps = {
  controlId: string;
  width: number;
  height: number;
  disabled: boolean;
  setControl: (id: string, value: KapulaInputValue, immediate: boolean) => void;
  /**
   * Drawn as a visible pad (a `touchpad` control) rather than the invisible
   * background a `raw` control is; the label sits faintly in its middle.
   */
  pad?: { label?: string };
};

/**
 * A multitouch surface filling its parent: the whole controller box for a
 * `raw` control (under the other controls), or the pad's box for a
 * `touchpad`. Every finger gets a slot id at touch-down and reports its
 * position in the box until it lifts. Touch-downs and lifts flush at once
 * like button edges; movement rides the input sender's throttle. Each
 * finger's pointer is captured, so it keeps reporting (clamped to the edge)
 * when it slides off the box — and a finger that landed on another control
 * never reaches this surface at all.
 */
export const RawTouchSurface = ({
  controlId,
  width,
  height,
  disabled,
  setControl,
  pad,
}: RawTouchSurfaceProps) => {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  // pointerId → the finger's slot and position. A ref for the handlers, and
  // mirrored into state only to draw the finger markers.
  const touchesRef = useRef(new Map<number, KapulaRawTouch>());
  const [touches, setTouches] = useState<KapulaRawTouch[]>([]);
  const { synthetic } = useContentFrame();

  const publish = (immediate: boolean) => {
    const value = touchesValue(touchesRef.current.values());
    setTouches(value);
    setControl(controlId, value, immediate);
  };

  const positionOf = (clientX: number, clientY: number) => {
    const surface = surfaceRef.current;
    if (!surface) return null;
    const { dx, dy } = pointerDeltaInFrame(
      surface.getBoundingClientRect(),
      { width, height },
      synthetic,
      clientX,
      clientY,
    );
    return touchPosition(dx, dy, width, height);
  };

  const lift = (pointerId: number) => {
    if (!touchesRef.current.delete(pointerId)) return;
    publish(true);
  };

  // The menu (or a pause) covering the controller lifts every finger: the
  // pointerups land on the overlay, never here.
  useEffect(() => {
    if (!disabled || touchesRef.current.size === 0) return;
    touchesRef.current.clear();
    publish(true);
    // publish only closes over refs and stable props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  return (
    <div
      ref={surfaceRef}
      data-testid={`control-${controlId}`}
      data-touches={touches.length}
      className={`absolute inset-0 select-none${
        pad
          ? " rounded-2xl border-2 border-kp-border bg-kp-bg-tertiary/70 overflow-hidden flex items-center justify-center"
          : ""
      }${pad && disabled ? " opacity-40" : ""}`}
      style={{ touchAction: "none" }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (disabled) return;
        const id = allocateTouchSlot(
          [...touchesRef.current.values()].map((t) => t.id),
        );
        const position = positionOf(e.clientX, e.clientY);
        if (id === null || !position) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        touchesRef.current.set(e.pointerId, { id, ...position });
        publish(true);
      }}
      onPointerMove={(e) => {
        const touch = touchesRef.current.get(e.pointerId);
        if (!touch) return;
        const position = positionOf(e.clientX, e.clientY);
        if (!position || (position.x === touch.x && position.y === touch.y)) {
          return;
        }
        touchesRef.current.set(e.pointerId, { id: touch.id, ...position });
        publish(false);
      }}
      onPointerUp={(e) => lift(e.pointerId)}
      onPointerCancel={(e) => lift(e.pointerId)}
    >
      {pad?.label && (
        <span className="text-sm font-bold text-kp-text-secondary pointer-events-none">
          {pad.label}
        </span>
      )}
      {touches.map((touch) => (
        <span
          key={touch.id}
          className="absolute w-14 h-14 -ml-7 -mt-7 rounded-full border-2 border-kp-accent-primary bg-kp-accent-primary/20 pointer-events-none"
          style={{ left: touch.x * width, top: touch.y * height }}
        />
      ))}
    </div>
  );
};
