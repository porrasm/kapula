import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ControlSchema } from "@kapula/protocol";
import { normalizeScreenAngle, type ScreenAngle } from "./gyro-utils.js";
import { orientationLock, type Viewport } from "./layout-utils.js";
import {
  DEFAULT_LANDSCAPE_ANGLE,
  allowedOrientations,
  contentAngleCycle,
  contentBox,
  initialContentAngle,
  isConsistentAngle,
  naturalOrientation,
  nextContentAngle,
  orientationAt,
  physicalOrientation,
  reconcileContentAngle,
  rotateInsets,
  syntheticRotation,
  type ContentOrientation,
  type LandscapeAngle,
} from "./orientation-utils.js";
import { useSafeAreaInsets } from "./safe-area.js";

/**
 * The surface a controller plays on. It owns the orientation (the pure
 * rules are in orientation-utils.ts): the schema's demand — or, for
 * schemas that work either way, how the phone is held when the surface
 * comes up — is frozen for as long as it is mounted. When the OS rotates
 * the viewport anyway (a tilt past the auto-rotate threshold), the content
 * is counter-rotated with a CSS transform into a box with swapped sides, so
 * on screen nothing moves. That also makes a landscape controller playable
 * under iOS's portrait-only rotation lock: the player just holds the phone
 * sideways.
 *
 * Everything inside — header, controller, pause overlay — rotates together,
 * and the safe-area insets are rotated with it, so the notch is padded on
 * whichever content edge it physically lies along. Children read the
 * content frame through `useContentFrame()`: the gyro needs the
 * device-relative content angle, touch controls the synthetic rotation to
 * map pointer movement, and the rotate chip the manual cycle.
 *
 * On platforms that allow it (installed or fullscreen Android Chrome) the
 * OS is also asked to lock to the frozen orientation, which spares the
 * rotation animation; everywhere else the CSS path alone does the job.
 */

export type ContentFrame = {
  /** Device-relative rotation of the content — what the tilt math needs. */
  angle: ScreenAngle;
  /** What CSS adds to the OS rotation; pointer deltas invert this. */
  synthetic: ScreenAngle;
  orientation: ContentOrientation;
  /** False when the schema's lock leaves a single way to hold the phone. */
  canRotate: boolean;
  /** Cycles landscape (both directions) and portrait, as the lock allows. */
  rotate: () => void;
};

const ContentFrameContext = createContext<ContentFrame>({
  angle: 0,
  synthetic: 0,
  orientation: "landscape",
  canRotate: false,
  rotate: () => {},
});

export const useContentFrame = (): ContentFrame => useContext(ContentFrameContext);

// --- The OS's screen angle ---

const readPhysicalAngle = (): ScreenAngle =>
  normalizeScreenAngle(
    screen.orientation?.angle ??
      (window as unknown as { orientation?: number }).orientation ??
      0,
  );

const subscribePhysicalAngle = (listener: () => void) => {
  screen.orientation?.addEventListener("change", listener);
  window.addEventListener("orientationchange", listener);
  window.addEventListener("resize", listener);
  return () => {
    screen.orientation?.removeEventListener("change", listener);
    window.removeEventListener("orientationchange", listener);
    window.removeEventListener("resize", listener);
  };
};

const usePhysicalAngle = (): ScreenAngle =>
  useSyncExternalStore(subscribePhysicalAngle, readPhysicalAngle, () => 0);

// --- The player's landscape direction, remembered across games ---

const LANDSCAPE_ANGLE_KEY = "gamepad:landscape-angle";

const loadLandscapeAngle = (): LandscapeAngle => {
  try {
    const raw = localStorage.getItem(LANDSCAPE_ANGLE_KEY);
    return raw === "270" ? 270 : DEFAULT_LANDSCAPE_ANGLE;
  } catch {
    return DEFAULT_LANDSCAPE_ANGLE;
  }
};

const saveLandscapeAngle = (angle: LandscapeAngle) => {
  try {
    localStorage.setItem(LANDSCAPE_ANGLE_KEY, String(angle));
  } catch {
    /* private mode etc. — the default direction is used next time */
  }
};

// --- The surface ---

type ScreenLock = {
  lock?: (orientation: string) => Promise<void>;
  unlock?: () => void;
};

type OrientedSurfaceProps = {
  schema: ControlSchema;
  /**
   * Ask the OS to lock to the frozen orientation while mounted. Off for the
   * help page's inline demo, which must not lock the page it scrolls in.
   */
  lockScreen?: boolean;
  /** Must position the element (fixed, relative…): the content box is absolute inside it. */
  className?: string;
  children: ReactNode;
};

export const OrientedSurface = ({
  schema,
  lockScreen = true,
  className = "",
  children,
}: OrientedSurfaceProps) => {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const reportedAngle = usePhysicalAngle();
  const physicalInsets = useSafeAreaInsets();
  const lock = orientationLock(schema);
  // The frozen choice: null until the first measurement decides it.
  const [chosen, setChosen] = useState<ScreenAngle | null>(null);

  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const measure = () =>
      setViewport({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const measured =
    viewport !== null && viewport.width > 0 && viewport.height > 0;

  // The device's natural orientation never changes, so it is read once,
  // from the first measurement — the one moment the viewport and the OS
  // angle are known to agree. During a rotation the resize and the
  // orientation-change event land on different frames; while they disagree
  // the last angle that was consistent with the viewport's shape stands in,
  // so the content box never takes the wrong shape even for a frame.
  const naturalRef = useRef<ContentOrientation | null>(null);
  const lastAngleRef = useRef<{ upright: ScreenAngle; turned: ScreenAngle }>({
    upright: 0,
    turned: DEFAULT_LANDSCAPE_ANGLE,
  });
  let natural: ContentOrientation = "portrait";
  let physical: ScreenAngle = 0;
  if (measured) {
    naturalRef.current ??= naturalOrientation(viewport, reportedAngle);
    natural = naturalRef.current;
    if (isConsistentAngle(viewport, natural, reportedAngle)) {
      physical = reportedAngle;
      if (physical % 180 === 0) lastAngleRef.current.upright = physical;
      else lastAngleRef.current.turned = physical;
    } else {
      physical =
        physicalOrientation(viewport) === natural
          ? lastAngleRef.current.upright
          : lastAngleRef.current.turned;
    }
  }

  // The first measurement (or a schema whose lock disallows the current
  // choice) decides the angle in render, so it is right on the very frame;
  // the state only records it.
  let angle: ScreenAngle = 0;
  if (measured) {
    angle =
      chosen !== null &&
      allowedOrientations(lock).includes(orientationAt(chosen, natural))
        ? chosen
        : initialContentAngle(lock, viewport, physical, loadLandscapeAngle());
  }
  useEffect(() => {
    if (measured && angle !== chosen) setChosen(angle);
  }, [measured, angle, chosen]);

  // The OS turned the phone: adopt its angle when it lands in the content's
  // orientation, keep ours when it does not. Only on a change of the OS
  // angle — reconciling every render would undo a manual flip at once — and
  // before paint, so the counter-rotation never shows a stale frame.
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  useLayoutEffect(() => {
    const current = viewportRef.current;
    if (!current) return;
    setChosen((c) =>
      c === null ? c : reconcileContentAngle(c, current, physical),
    );
  }, [physical]);

  const orientation = orientationAt(angle, natural);
  useEffect(() => {
    if (measured && orientation === "landscape" && (angle === 90 || angle === 270)) {
      saveLandscapeAngle(angle);
    }
  }, [measured, orientation, angle]);

  // Best effort: rejects (or is missing) everywhere but installed/fullscreen
  // Android Chrome. The CSS rotation below is the mechanism; this only
  // spares the OS rotation animation where it works.
  useEffect(() => {
    if (!lockScreen || !measured) return;
    const so = screen.orientation as unknown as ScreenLock | undefined;
    if (typeof so?.lock !== "function") return;
    so.lock(orientation).catch(() => {});
    return () => {
      try {
        so.unlock?.();
      } catch {
        /* nothing was locked */
      }
    };
  }, [lockScreen, measured, orientation]);

  const canRotate = contentAngleCycle(lock, natural).length > 1;
  const rotate = () => setChosen(nextContentAngle(angle, lock, natural));

  const synthetic = syntheticRotation(angle, physical);
  const box = measured ? contentBox(viewport, synthetic) : null;
  const insets = rotateInsets(physicalInsets, synthetic);

  return (
    <div ref={outerRef} className={`overflow-hidden ${className}`}>
      {measured && box && (
        <ContentFrameContext.Provider
          value={{ angle, synthetic, orientation, canRotate, rotate }}
        >
          <div
            data-testid="oriented-surface"
            data-content-angle={angle}
            data-synthetic-rotation={synthetic}
            className="absolute flex flex-col box-border"
            style={{
              left: (viewport.width - box.width) / 2,
              top: (viewport.height - box.height) / 2,
              width: box.width,
              height: box.height,
              transform: synthetic === 0 ? undefined : `rotate(${synthetic}deg)`,
              paddingTop: insets.top,
              paddingRight: insets.right,
              paddingBottom: insets.bottom,
              paddingLeft: insets.left,
            }}
          >
            {children}
          </div>
        </ContentFrameContext.Provider>
      )}
    </div>
  );
};
