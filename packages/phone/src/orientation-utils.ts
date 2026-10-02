import { normalizeScreenAngle, type ScreenAngle } from "./gyro-utils.js";
import type { OrientationLock, Viewport } from "./layout-utils.js";

/**
 * Pure orientation ownership: the controller decides which way it is held
 * and never lets the OS re-lay it out mid-game. Kept free of React and the
 * DOM so the unit tests can drive every rotation case directly.
 *
 * The trouble this solves (see "Owning the orientation" in GAMEPAD.md): a
 * tilt past the auto-rotate threshold flips the viewport, which used to
 * re-layout an unlocked schema and replace a landscape one with a rotate
 * prompt — while the player was steering. And the natural defence, locking
 * rotation in the OS, is portrait-only on iPhones, so a landscape schema
 * became a permanent prompt.
 *
 * Vocabulary:
 * - The *physical* viewport and *physical angle* are what the OS gives us:
 *   the window's size and `screen.orientation.angle` (how far the screen
 *   content is rotated from the device's natural orientation).
 * - The *content angle* is device-relative: how far the controller's content
 *   is rotated from the device's natural orientation. Being device-relative
 *   is the whole point — it does not move when the OS rotates the viewport.
 *   The gyro math takes exactly this angle, since the tilt sensor reports in
 *   the device frame.
 * - The *synthetic rotation* is what CSS has to add on top of the OS's
 *   rotation to show the content at its content angle. Zero when the OS is
 *   already there.
 *
 * Angle convention (fixed by the gyro unit tests): 90 means the device's
 * top edge is on the content's left — the phone rotated counter-clockwise,
 * the usual "notch on the left" landscape hold — which is CSS
 * `rotate(90deg)` applied to portrait content.
 */

export type ContentOrientation = "landscape" | "portrait";

const opposite = (o: ContentOrientation): ContentOrientation =>
  o === "landscape" ? "portrait" : "landscape";

/** Which way the OS viewport currently is. */
export const physicalOrientation = (viewport: Viewport): ContentOrientation =>
  viewport.height > viewport.width ? "portrait" : "landscape";

/**
 * The device's natural orientation (phones: portrait; most tablets and every
 * desktop window: landscape), recovered from the viewport and how far the OS
 * says it has rotated the screen from natural.
 */
export const naturalOrientation = (
  viewport: Viewport,
  physicalAngle: ScreenAngle,
): ContentOrientation =>
  physicalAngle % 180 === 0
    ? physicalOrientation(viewport)
    : opposite(physicalOrientation(viewport));

/**
 * Whether the OS's reported angle agrees with the viewport's shape. During
 * a rotation the resize and the orientation-change event land separately,
 * so for a frame one of them is stale; a surface must not act on the pair
 * until they agree (it substitutes the last consistent angle meanwhile).
 */
export const isConsistentAngle = (
  viewport: Viewport,
  natural: ContentOrientation,
  physicalAngle: ScreenAngle,
): boolean =>
  (physicalAngle % 180 === 0) === (physicalOrientation(viewport) === natural);

/** The orientation content shown at a device-relative angle ends up in. */
export const orientationAt = (
  angle: ScreenAngle,
  natural: ContentOrientation,
): ContentOrientation => (angle % 180 === 0 ? natural : opposite(natural));

/** The two device-relative angles that show content in an orientation. */
export const anglesFor = (
  orientation: ContentOrientation,
  natural: ContentOrientation,
): [ScreenAngle, ScreenAngle] =>
  orientation === natural ? [0, 180] : [90, 270];

/** What a schema's lock allows; `null` locks work either way. */
export const allowedOrientations = (
  lock: OrientationLock,
): ContentOrientation[] =>
  lock === "landscape"
    ? ["landscape"]
    : lock === "portrait"
      ? ["portrait"]
      : ["portrait", "landscape"];

export type LandscapeAngle = 90 | 270;

/** The landscape hold assumed when nothing says otherwise: top edge on the left. */
export const DEFAULT_LANDSCAPE_ANGLE: LandscapeAngle = 90;

/**
 * The content angle when a controller comes up: the schema's demand, else
 * the way the phone is held right now. When the OS is already in the wanted
 * orientation its angle is adopted as is (it knows which way the phone is
 * turned); otherwise the content is rotated into the wanted orientation —
 * for landscape, the direction the player last used.
 */
export const initialContentAngle = (
  lock: OrientationLock,
  viewport: Viewport,
  physicalAngle: ScreenAngle,
  preferredLandscapeAngle: LandscapeAngle = DEFAULT_LANDSCAPE_ANGLE,
): ScreenAngle => {
  const physical = physicalOrientation(viewport);
  const wanted: ContentOrientation = lock ?? physical;
  if (wanted === physical) return physicalAngle;
  const natural = naturalOrientation(viewport, physicalAngle);
  const candidates = anglesFor(wanted, natural);
  if (wanted === "landscape" && candidates.includes(preferredLandscapeAngle)) {
    return preferredLandscapeAngle;
  }
  return candidates[0];
};

/**
 * Keeps a frozen content angle in step with the OS: while the OS is in the
 * content's orientation, its angle wins (the player turned the phone around
 * and the OS followed — content glued to the device would be upside down for
 * them). When the OS is in the other orientation — the mid-tilt flip this
 * module exists to absorb — the content angle stands.
 */
export const reconcileContentAngle = (
  contentAngle: ScreenAngle,
  viewport: Viewport,
  physicalAngle: ScreenAngle,
): ScreenAngle => {
  const natural = naturalOrientation(viewport, physicalAngle);
  return orientationAt(physicalAngle, natural) ===
    orientationAt(contentAngle, natural)
    ? physicalAngle
    : contentAngle;
};

/**
 * The manual rotate control's sequence: both landscape holds, then the
 * upright portrait one, restricted to what the schema's lock allows. A
 * single entry means there is nothing to rotate to (no control is shown).
 */
export const contentAngleCycle = (
  lock: OrientationLock,
  natural: ContentOrientation,
): ScreenAngle[] => {
  const allowed = allowedOrientations(lock);
  const cycle: ScreenAngle[] = [];
  if (allowed.includes("landscape")) cycle.push(...anglesFor("landscape", natural));
  if (allowed.includes("portrait")) cycle.push(anglesFor("portrait", natural)[0]);
  return cycle;
};

export const nextContentAngle = (
  current: ScreenAngle,
  lock: OrientationLock,
  natural: ContentOrientation,
): ScreenAngle => {
  const cycle = contentAngleCycle(lock, natural);
  const index = cycle.indexOf(current);
  return cycle[(index + 1) % cycle.length];
};

/** What CSS must add to the OS's rotation to show content at `contentAngle`. */
export const syntheticRotation = (
  contentAngle: ScreenAngle,
  physicalAngle: ScreenAngle,
): ScreenAngle => normalizeScreenAngle(contentAngle - physicalAngle);

/** The box the content lays out in: the physical one, sides swapped when rotated a quarter turn. */
export const contentBox = (
  viewport: Viewport,
  synthetic: ScreenAngle,
): Viewport =>
  synthetic % 180 === 0
    ? viewport
    : { width: viewport.height, height: viewport.width };

/**
 * A pointer movement in client (physical) coordinates, expressed in the
 * content's own coordinates — the inverse of the synthetic CSS rotation, so
 * a stick dragged toward the content's top reads as up whichever way the
 * physical viewport is turned.
 */
export const rotateDelta = (
  dx: number,
  dy: number,
  synthetic: ScreenAngle,
): { dx: number; dy: number } => {
  switch (synthetic) {
    case 90:
      return { dx: dy, dy: -dx };
    case 180:
      return { dx: -dx, dy: -dy };
    case 270:
      return { dx: -dy, dy: dx };
    default:
      return { dx, dy };
  }
};

export type Insets = { top: number; right: number; bottom: number; left: number };

/**
 * The physical safe-area insets (notch, home indicator) on the content's
 * edges: with a quarter-turn synthetic rotation the device's top edge lies
 * along one of the content's sides, so the notch must be padded there.
 */
export const rotateInsets = (insets: Insets, synthetic: ScreenAngle): Insets => {
  switch (synthetic) {
    case 90:
      // Content top is on the device's right edge.
      return {
        top: insets.right,
        right: insets.bottom,
        bottom: insets.left,
        left: insets.top,
      };
    case 180:
      return {
        top: insets.bottom,
        right: insets.left,
        bottom: insets.top,
        left: insets.right,
      };
    case 270:
      return {
        top: insets.left,
        right: insets.top,
        bottom: insets.right,
        left: insets.bottom,
      };
    default:
      return insets;
  }
};
