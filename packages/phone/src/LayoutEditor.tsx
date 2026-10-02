import { useEffect, useRef, useState } from "react";
import type { ControlSchema } from "@kapula/protocol";
import { Button } from "./ui.js";
import { ControlWidget, controlBoxStyle } from "./ControlWidget.js";
import {
  alignmentLines,
  applyLayoutOverride,
  clampBox,
  gestureBox,
  isStickModeToggleable,
  scaleBox,
  SIZE_STEP,
  snapBox,
  type ControlBox,
  type Point,
  type SnapLines,
} from "./layout-override.js";
import { resolveLayout, type Viewport } from "./layout-utils.js";
import { useContentFrame } from "./OrientedSurface.js";
import type { LayoutOverrideHandle } from "./useLayoutOverride.js";

type LayoutEditorProps = {
  schema: ControlSchema;
  layout: LayoutOverrideHandle;
  onDone: () => void;
};

const NOOP_SET_CONTROL = () => {};
const NO_GUIDES: SnapLines = { x: [], y: [] };

/**
 * The player's layout editor: the controller as it will play, with a drag
 * handle over every control. One finger drags a control, two fingers on it
 * pinch it bigger or smaller; the header's −/+ do the same for the tapped
 * control (and are what a mouse user gets). Holding a finger still on a
 * full or relative stick swaps it between those two modes — the fixed
 * center versus the thumb's landing point, a matter of feel the driver
 * cannot decide, and invisible on the wire. Every gesture is written to the
 * layout override straight away, so "Done" simply returns to the game —
 * there is nothing to save or discard.
 *
 * Must sit inside an `OrientedSurface`, in the exact slot the live
 * controller occupies: same box, same orientation, so what is edited is
 * what plays. The header keeps the session header's height for the same
 * reason.
 */
export const LayoutEditor = ({ schema, layout, onDone }: LayoutEditorProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The lines the control being dragged is currently stuck to, drawn while
  // the finger is down so the snap is visible rather than merely felt.
  const [guides, setGuides] = useState<SnapLines>(NO_GUIDES);

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
  const resolved = measured
    ? applyLayoutOverride(resolveLayout(schema, viewport), layout.override, viewport)
        .controls
    : [];
  const selected = resolved.find((c) => c.control.id === selectedId) ?? null;
  const anyToggleableStick = schema.controls.some(isStickModeToggleable);

  const resize = (factor: number) => {
    if (!selected || !measured) return;
    layout.setBox(selected.control.id, scaleBox(selected, factor, viewport), viewport);
  };

  return (
    <>
      <header
        className="flex items-center gap-2 border-b border-kp-border"
        style={{ padding: "0.5rem 1rem" }}
        data-testid="layout-editor-header"
      >
        <span className="text-sm text-kp-text-primary font-medium flex-1 truncate">
          Edit layout
        </span>
        <Button
          size="small"
          variant="secondary"
          aria-label="Smaller"
          data-testid="layout-smaller"
          disabled={!selected}
          onClick={() => resize(1 / SIZE_STEP)}
        >
          −
        </Button>
        <Button
          size="small"
          variant="secondary"
          aria-label="Bigger"
          data-testid="layout-bigger"
          disabled={!selected}
          onClick={() => resize(SIZE_STEP)}
        >
          +
        </Button>
        <Button
          size="small"
          variant="secondary"
          data-testid="layout-editor-reset"
          disabled={!layout.hasEdits}
          onClick={layout.reset}
        >
          Reset
        </Button>
        <Button size="small" data-testid="layout-editor-done" onClick={onDone}>
          Done
        </Button>
      </header>
      <div
        ref={containerRef}
        className="flex-1 relative overflow-hidden select-none"
        style={{ touchAction: "none" }}
        data-testid="layout-editor"
      >
        {measured &&
          resolved.map((control) => (
            <ControlWidget
              key={control.control.id}
              resolved={control}
              disabled={false}
              inert
              setControl={NOOP_SET_CONTROL}
            />
          ))}
        {measured &&
          resolved.map((control) => (
            <DragHandle
              key={control.control.id}
              controlId={control.control.id}
              box={control}
              selected={control.control.id === selectedId}
              onSelect={() => setSelectedId(control.control.id)}
              onGesture={(next, snapping) => {
                // Only a one-finger drag snaps: while pinching, the size is
                // what the player is aiming at and a jumping center fights it.
                const lines = snapping
                  ? alignmentLines(
                      resolved
                        .filter((other) => other.control.id !== control.control.id)
                        .map(({ x, y, width, height }) => ({ x, y, width, height })),
                      viewport,
                    )
                  : NO_GUIDES;
                const snapped = snapping
                  ? snapBox(next, lines)
                  : { box: next, guides: NO_GUIDES };
                setGuides(snapped.guides);
                layout.setBox(
                  control.control.id,
                  clampBox(snapped.box, viewport),
                  viewport,
                );
              }}
              onGestureEnd={() => setGuides(NO_GUIDES)}
              onLongPress={
                isStickModeToggleable(control.control)
                  ? () => {
                      layout.toggleStick(control.control);
                      if ("vibrate" in navigator) navigator.vibrate(30);
                    }
                  : undefined
              }
            />
          ))}
        <Guides guides={guides} />
        <div className="absolute top-2 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-kp-bg-tertiary/90 border border-kp-border text-xs text-kp-text-secondary whitespace-nowrap pointer-events-none">
          {anyToggleableStick
            ? "Drag to move · pinch to resize · hold a stick to swap its mode"
            : "Drag to move · pinch to resize"}
        </div>
      </div>
    </>
  );
};

/**
 * The alignment lines a dragged control is stuck to. Hairlines across the
 * whole editor, so it is obvious *what* the control lined up with — the
 * control opposite, or the middle of the screen.
 */
const Guides = ({ guides }: { guides: SnapLines }) => (
  <>
    {guides.x.map((x) => (
      <div
        key={`x${x}`}
        className="absolute top-0 bottom-0 w-px bg-kp-accent-primary pointer-events-none"
        style={{ left: Math.round(x) }}
        data-testid="layout-guide-x"
      />
    ))}
    {guides.y.map((y) => (
      <div
        key={`y${y}`}
        className="absolute left-0 right-0 h-px bg-kp-accent-primary pointer-events-none"
        style={{ top: Math.round(y) }}
        data-testid="layout-guide-y"
      />
    ))}
  </>
);

/** How long a finger must rest on a stick to swap its mode. */
export const LONG_PRESS_MS = 500;
/** A finger drifting further than this is a drag, not a press. */
const LONG_PRESS_SLOP_PX = 8;

/**
 * The transparent gesture surface over one control. Pointers are tracked by
 * id; the gesture is measured from a baseline (the box and pointer positions
 * when the set of pointers last changed), so a second finger landing
 * mid-drag, or one lifting mid-pinch, never makes the control jump.
 *
 * With `onLongPress`, a single finger resting still for LONG_PRESS_MS fires
 * it instead: the touch is then spent — moving on without lifting drags
 * nothing, so the swap never comes with an accidental nudge.
 */
const DragHandle = ({
  controlId,
  box,
  selected,
  onSelect,
  onGesture,
  onGestureEnd,
  onLongPress,
}: {
  controlId: string;
  box: ControlBox;
  selected: boolean;
  onSelect: () => void;
  /** `snapping` is true for a one-finger drag — see the editor's handler. */
  onGesture: (next: ControlBox, snapping: boolean) => void;
  onGestureEnd: () => void;
  onLongPress?: () => void;
}) => {
  const { synthetic } = useContentFrame();
  const pointersRef = useRef(new Map<number, Point>());
  const baseRef = useRef<{ box: ControlBox; pointers: Map<number, Point> } | null>(
    null,
  );
  const boxRef = useRef(box);
  boxRef.current = box;
  const longPressRef = useRef<{ timer: number; origin: Point } | null>(null);
  // Set when a long press fired: the rest of that touch is ignored.
  const spentRef = useRef(false);

  const cancelLongPress = () => {
    if (!longPressRef.current) return;
    window.clearTimeout(longPressRef.current.timer);
    longPressRef.current = null;
  };

  useEffect(() => cancelLongPress, []);

  const rebase = () => {
    baseRef.current = {
      box: boxRef.current,
      pointers: new Map(pointersRef.current),
    };
  };

  const end = (pointerId: number) => {
    cancelLongPress();
    if (!pointersRef.current.delete(pointerId)) return;
    if (pointersRef.current.size > 0) rebase();
    else {
      baseRef.current = null;
      spentRef.current = false;
      onGestureEnd();
    }
  };

  return (
    <div
      data-testid={`edit-${controlId}`}
      data-selected={selected}
      className={`absolute rounded-2xl border-2 ${
        selected
          ? "border-kp-accent-primary"
          : "border-dashed border-kp-border"
      }`}
      style={{ ...controlBoxStyle(box), touchAction: "none" }}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        onSelect();
        rebase();
        // A second finger means a pinch, never a press.
        cancelLongPress();
        if (onLongPress && pointersRef.current.size === 1) {
          const origin = { x: e.clientX, y: e.clientY };
          longPressRef.current = {
            origin,
            timer: window.setTimeout(() => {
              longPressRef.current = null;
              spentRef.current = true;
              onLongPress();
            }, LONG_PRESS_MS),
          };
        }
      }}
      onPointerMove={(e) => {
        if (!pointersRef.current.has(e.pointerId)) return;
        pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const press = longPressRef.current;
        if (
          press &&
          Math.hypot(e.clientX - press.origin.x, e.clientY - press.origin.y) >
            LONG_PRESS_SLOP_PX
        ) {
          cancelLongPress();
        }
        if (spentRef.current) return;
        const base = baseRef.current;
        if (!base) return;
        const from: Point[] = [];
        const to: Point[] = [];
        for (const [id, start] of base.pointers) {
          const now = pointersRef.current.get(id);
          if (!now) continue;
          from.push(start);
          to.push(now);
        }
        onGesture(gestureBox(base.box, from, to, synthetic), from.length === 1);
      }}
      onPointerUp={(e) => end(e.pointerId)}
      onPointerCancel={(e) => end(e.pointerId)}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
};
