import { useRef, useState } from "react";
import type { KapulaDpadDirection } from "@kapula/protocol";
import { pointToDpadDirection } from "./layout-utils.js";
import { pointerDeltaInFrame } from "./pointer-utils.js";
import { useContentFrame } from "./OrientedSurface.js";

type DpadProps = {
  size: number;
  label?: string;
  testId?: string;
  disabled: boolean;
  /** Fires only when the direction actually changes; release sends "rest". */
  onChange: (direction: KapulaDpadDirection) => void;
};

/**
 * A "dpad" joystick: 9 discrete states instead of analog axes. Rendered as a
 * rounded square with four arrows (a diagonal lights up two of them) so
 * players can tell at a glance there are no fine-tune values.
 */
export const Dpad = ({ size, label, testId, disabled, onChange }: DpadProps) => {
  const padRef = useRef<HTMLDivElement | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const [direction, setDirection] = useState<KapulaDpadDirection>("c");
  const directionRef = useRef<KapulaDpadDirection>("c");
  const { synthetic } = useContentFrame();

  const apply = (next: KapulaDpadDirection) => {
    if (next === directionRef.current) return;
    directionRef.current = next;
    setDirection(next);
    onChange(next);
  };

  const updateFromPointer = (clientX: number, clientY: number) => {
    const pad = padRef.current;
    if (!pad) return;
    // Client → pad coordinates, undoing the surface's rotation/scale, so
    // "up" is the pad's up however the physical viewport is turned.
    const { dx, dy } = pointerDeltaInFrame(
      pad.getBoundingClientRect(),
      { width: size, height: size },
      synthetic,
      clientX,
      clientY,
    );
    apply(pointToDpadDirection(dx, dy, size / 2));
  };

  const release = () => {
    pointerIdRef.current = null;
    apply("c");
  };

  // One color class per state — appending a second text-* class would leave
  // the winner to stylesheet order, not to the active direction.
  const arrowClass = (arrow: "u" | "r" | "d" | "l") =>
    `absolute leading-none pointer-events-none ${
      direction.includes(arrow)
        ? "text-kp-accent-primary"
        : "text-kp-text-secondary"
    }`;
  const arrowSize = Math.max(14, Math.round(size * 0.18));

  return (
    <div
      ref={padRef}
      data-testid={testId}
      data-direction={direction}
      className={`relative rounded-2xl bg-kp-bg-tertiary border border-kp-border select-none ${
        disabled ? "opacity-40" : ""
      }`}
      style={{ width: size, height: size, touchAction: "none" }}
      onPointerDown={(e) => {
        if (disabled || pointerIdRef.current !== null) return;
        pointerIdRef.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
        updateFromPointer(e.clientX, e.clientY);
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
      <span
        className={`${arrowClass("u")} top-1 left-1/2 -translate-x-1/2`}
        style={{ fontSize: arrowSize }}
      >
        ▲
      </span>
      <span
        className={`${arrowClass("r")} right-1 top-1/2 -translate-y-1/2`}
        style={{ fontSize: arrowSize }}
      >
        ▶
      </span>
      <span
        className={`${arrowClass("d")} bottom-1 left-1/2 -translate-x-1/2`}
        style={{ fontSize: arrowSize }}
      >
        ▼
      </span>
      <span
        className={`${arrowClass("l")} left-1 top-1/2 -translate-y-1/2`}
        style={{ fontSize: arrowSize }}
      >
        ◀
      </span>
      <span
        className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 ${
          direction === "c"
            ? "border-kp-border bg-kp-bg-secondary"
            : "border-kp-accent-primary"
        }`}
        style={{
          width: Math.round(size * 0.26),
          height: Math.round(size * 0.26),
        }}
      />
      {label && (
        <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 translate-y-full text-[10px] text-kp-text-secondary uppercase tracking-wide pointer-events-none">
          {label}
        </span>
      )}
    </div>
  );
};
