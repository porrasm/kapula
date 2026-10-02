import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  getRawControl,
  type ControlSchema,
  type GamepadBackground,
  type GamepadPlayerClientMessage,
} from "@kapula/protocol";
import { ControlWidget } from "./ControlWidget.js";
import { applyLayoutOverride, type LayoutOverride } from "./layout-override.js";
import { resolveLayout, type Viewport } from "./layout-utils.js";
import { useContentFrame } from "./OrientedSurface.js";
import { RawTouchSurface } from "./RawTouchSurface.js";
import { TextEntry } from "./TextEntry.js";
import { requestGyroAccess, useGyroInput, type GyroAccess } from "./useGyro.js";
import type { SeqCounter } from "./seq-counter.js";
import {
  POINTER_THROTTLE_MS,
  THROTTLE_MS,
  useInputSender,
} from "./useInputSender.js";
import { useMotionStream } from "./useMotionStream.js";
import { useWakeLock } from "./useWakeLock.js";

type ControllerProps = {
  schema: ControlSchema;
  send: (msg: GamepadPlayerClientMessage) => void;
  /** Paused sessions render the controller inert under an overlay. */
  disabled: boolean;
  /** The help-page demo renders live without holding a screen wake lock. */
  keepAwake?: boolean;
  /** The player's edits on top of the engine's layout (see layout-override.ts). */
  layoutOverride?: LayoutOverride | null;
  /** The player session's input seq counter; see seq-counter.ts. */
  seq?: SeqCounter;
  /** The driver's background image, drawn behind the controls. */
  background?: GamepadBackground;
};

/**
 * Renders the active control schema through the layout engine in
 * layout-utils.ts: sticks under resting thumbs, primary buttons as a diamond,
 * overflow buttons as shoulder/aux pills. Pointer events give multitouch (one
 * thumb steering while the other shoots) without any gesture library.
 *
 * Must sit inside an `OrientedSurface`: the surface owns which way the
 * controller is held, so the box measured here is always the right shape for
 * the schema and the layout never flips mid-game.
 */
export const Controller = ({
  schema,
  send,
  disabled,
  keepAwake = true,
  layoutOverride = null,
  seq,
  background,
}: ControllerProps) => {
  const hasPointerSurface = schema.controls.some(
    (c) => c.type === "raw" || c.type === "touchpad",
  );
  const { setControl } = useInputSender(
    send,
    !disabled,
    seq,
    hasPointerSurface ? POINTER_THROTTLE_MS : THROTTLE_MS,
  );
  useWakeLock(keepAwake && !disabled);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const frame = useContentFrame();
  // The `text` control whose field is open, if any.
  const [textId, setTextId] = useState<string | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);
  const textControl = schema.controls.find(
    (c): c is Extract<typeof c, { type: "text" }> =>
      c.type === "text" && c.id === textId,
  );
  // Mounted and focused inside the tap itself: iOS raises the keyboard only
  // for a focus that happens in a user gesture, so the field cannot wait
  // for an effect to focus it.
  const openText = (controlId: string) => {
    flushSync(() => setTextId(controlId));
    textInputRef.current?.focus();
  };
  // A pause (or the menu) covering the controller closes the field.
  useEffect(() => {
    if (disabled) setTextId(null);
  }, [disabled]);

  // Sensor controls are hardware, not layout: they never occupy a thumb
  // zone. Their only on-screen presence is the chip row along the top edge.
  const gyroControl = schema.controls.find((c) => c.type === "gyro");
  const gyro = useGyroInput({
    control: gyroControl,
    enabled: !disabled,
    screenAngle: frame.angle,
    setControl,
  });
  const motionControl = schema.controls.find((c) => c.type === "motion");
  const motion = useMotionStream({
    control: motionControl,
    enabled: !disabled,
    send,
  });

  // Kill pull-to-refresh / overscroll while the controller is up; an
  // accidental page reload silently rejoins, but better to not trigger it.
  useEffect(() => {
    const previous = document.body.style.overscrollBehavior;
    document.body.style.overscrollBehavior = "none";
    return () => {
      document.body.style.overscrollBehavior = previous;
    };
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () =>
      setViewport({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const measured = viewport !== null && viewport.width > 0 && viewport.height > 0;
  // A raw control is the box's background: drawn first, so every laid-out
  // control sits on top of it and keeps the fingers that land on it.
  const rawControl = getRawControl(schema);

  return (
    <div
      ref={containerRef}
      className="flex-1 relative overflow-hidden select-none"
      style={{ touchAction: "none", ...backgroundStyle(background) }}
      data-background={background?.url}
    >
      {measured && rawControl && (
        <RawTouchSurface
          controlId={rawControl.id}
          width={viewport.width}
          height={viewport.height}
          disabled={disabled}
          setControl={setControl}
        />
      )}
      {measured &&
        applyLayoutOverride(
          resolveLayout(schema, viewport),
          layoutOverride,
          viewport,
        ).controls.map((resolved) => (
          <ControlWidget
            key={resolved.control.id}
            resolved={resolved}
            disabled={disabled}
            setControl={setControl}
            onOpenText={openText}
          />
        ))}
      {textControl && !disabled && (
        <TextEntry
          key={textControl.id}
          ref={textInputRef}
          control={textControl}
          onSend={(text) =>
            send({ type: "text", controlId: textControl.id, text })
          }
          onClose={() => setTextId(null)}
        />
      )}
      <div className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-2">
        {gyroControl && (
          <SensorChip
            testId="gyro-chip"
            access={gyro.access}
            disabled={disabled}
            onTap={gyro.recalibrate}
            labels={{
              granted: "⟲ Tilt · tap to recenter",
              needsGesture: "Tap to enable tilt",
              denied: "Tilt blocked — motion access denied",
              unavailable: "Tilt unavailable on this device",
              pending: "Tilt…",
            }}
          />
        )}
        {motionControl && (
          <SensorChip
            testId="motion-chip"
            access={motion.access}
            disabled={disabled}
            labels={{
              granted: "◎ Motion streaming",
              needsGesture: "Tap to enable motion",
              denied: "Motion blocked — access denied",
              unavailable: "Motion unavailable on this device",
              pending: "Motion…",
            }}
          />
        )}
        {frame.canRotate && (
          <button
            data-testid="rotate-chip"
            disabled={disabled}
            className="px-3 py-1 rounded-full border text-xs whitespace-nowrap bg-kp-bg-tertiary text-kp-text-secondary border-kp-border disabled:opacity-40"
            style={{ touchAction: "none" }}
            onClick={frame.rotate}
            aria-label="Rotate the controller"
          >
            ⟳ Rotate
          </button>
        )}
      </div>
    </div>
  );
};

/**
 * The driver's image fills the controller box — the same box `raw` touch
 * coordinates and `x`/`y` positions are measured in — so "fill" lines image
 * pixels up with touch positions exactly.
 */
const backgroundStyle = (
  background: GamepadBackground | undefined,
): React.CSSProperties =>
  background
    ? {
        backgroundImage: `url("${background.url}")`,
        backgroundSize: background.fit === "fill" ? "100% 100%" : background.fit,
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
      }
    : {};

/**
 * A sensor control's footprint: a chip on the top edge showing that it is
 * live (tilt: tap = re-capture the neutral pose), or — since motion access
 * can only be requested from a tap after each page load — the tap that
 * enables it.
 */
const SensorChip = ({
  testId,
  access,
  disabled,
  onTap,
  labels,
}: {
  testId: string;
  access: GyroAccess;
  disabled: boolean;
  /** What a tap does once access is granted; nothing when omitted. */
  onTap?: () => void;
  labels: {
    granted: string;
    needsGesture: string;
    denied: string;
    unavailable: string;
    pending: string;
  };
}) => {
  // A live sensor with nothing to tap still reads as live, not greyed out.
  const inert = access === "denied" || access === "unavailable";
  return (
    <button
      disabled={disabled || inert}
      data-testid={testId}
      data-access={access}
      className={`px-3 py-1 rounded-full border text-xs whitespace-nowrap disabled:opacity-40 ${
        access === "needs-gesture"
          ? "bg-kp-accent-primary text-kp-accent-on-primary border-kp-accent-primary"
          : "bg-kp-bg-tertiary text-kp-text-secondary border-kp-border"
      }`}
      style={{ touchAction: "none" }}
      onClick={() => {
        if (access === "needs-gesture") void requestGyroAccess();
        else onTap?.();
      }}
    >
      {access === "granted"
        ? labels.granted
        : access === "needs-gesture"
          ? labels.needsGesture
          : access === "denied"
            ? labels.denied
            : access === "unavailable"
              ? labels.unavailable
              : labels.pending}
    </button>
  );
};
