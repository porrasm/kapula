import { test, expect } from "@playwright/test";
import {
  allowedOrientations,
  anglesFor,
  contentAngleCycle,
  contentBox,
  initialContentAngle,
  isConsistentAngle,
  naturalOrientation,
  nextContentAngle,
  orientationAt,
  physicalOrientation,
  reconcileContentAngle,
  rotateDelta,
  rotateInsets,
  syntheticRotation,
} from "@kapula/phone/utils";
import { pointerDeltaInFrame } from "@kapula/phone/utils";
import type { ScreenAngle } from "@kapula/phone/utils";
import type { Viewport } from "@kapula/phone/utils";

// A phone (natural portrait) as the OS reports it in each rotation.
const PHONE_PORTRAIT: Viewport = { width: 390, height: 844 };
const PHONE_LANDSCAPE: Viewport = { width: 844, height: 390 };
// A tablet / desktop window: natural landscape.
const WIDE_NATURAL: Viewport = { width: 1280, height: 800 };
const WIDE_ROTATED: Viewport = { width: 800, height: 1280 };

test.describe("natural orientation", () => {
  test("a phone is natural portrait whichever way the OS has turned it", () => {
    expect(naturalOrientation(PHONE_PORTRAIT, 0)).toBe("portrait");
    expect(naturalOrientation(PHONE_LANDSCAPE, 90)).toBe("portrait");
    expect(naturalOrientation(PHONE_LANDSCAPE, 270)).toBe("portrait");
    expect(naturalOrientation(PHONE_PORTRAIT, 180)).toBe("portrait");
  });

  test("a wide device is natural landscape", () => {
    expect(naturalOrientation(WIDE_NATURAL, 0)).toBe("landscape");
    expect(naturalOrientation(WIDE_ROTATED, 90)).toBe("landscape");
  });

  test("a reported angle is consistent only when it agrees with the viewport's shape", () => {
    // Mid-rotation the resize and the angle event land on different frames.
    expect(isConsistentAngle(PHONE_PORTRAIT, "portrait", 0)).toBe(true);
    expect(isConsistentAngle(PHONE_LANDSCAPE, "portrait", 90)).toBe(true);
    expect(isConsistentAngle(PHONE_PORTRAIT, "portrait", 90)).toBe(false);
    expect(isConsistentAngle(PHONE_LANDSCAPE, "portrait", 0)).toBe(false);
    expect(isConsistentAngle(WIDE_NATURAL, "landscape", 0)).toBe(true);
    expect(isConsistentAngle(WIDE_ROTATED, "landscape", 0)).toBe(false);
  });

  test("angles map to orientations relative to natural", () => {
    expect(orientationAt(0, "portrait")).toBe("portrait");
    expect(orientationAt(90, "portrait")).toBe("landscape");
    expect(orientationAt(90, "landscape")).toBe("portrait");
    expect(anglesFor("landscape", "portrait")).toEqual([90, 270]);
    expect(anglesFor("portrait", "portrait")).toEqual([0, 180]);
    expect(anglesFor("landscape", "landscape")).toEqual([0, 180]);
    expect(physicalOrientation(PHONE_PORTRAIT)).toBe("portrait");
  });
});

test.describe("initial content angle", () => {
  test("a landscape schema on an upright (or rotation-locked) phone rotates to the preferred hold", () => {
    expect(initialContentAngle("landscape", PHONE_PORTRAIT, 0)).toBe(90);
    expect(initialContentAngle("landscape", PHONE_PORTRAIT, 0, 270)).toBe(270);
  });

  test("when the OS already shows the wanted orientation its angle is adopted", () => {
    expect(initialContentAngle("landscape", PHONE_LANDSCAPE, 270)).toBe(270);
    expect(initialContentAngle("landscape", PHONE_LANDSCAPE, 90, 270)).toBe(90);
    expect(initialContentAngle("portrait", PHONE_PORTRAIT, 0)).toBe(0);
  });

  test("a portrait schema on a phone the OS turned sideways stands the content up", () => {
    expect(initialContentAngle("portrait", PHONE_LANDSCAPE, 90)).toBe(0);
    expect(initialContentAngle("portrait", PHONE_LANDSCAPE, 270)).toBe(0);
  });

  test("an unlocked schema follows how the phone is held right now", () => {
    expect(initialContentAngle(null, PHONE_PORTRAIT, 0)).toBe(0);
    expect(initialContentAngle(null, PHONE_LANDSCAPE, 90)).toBe(90);
  });

  test("a portrait schema in a desktop window rotates into a portrait box", () => {
    const angle = initialContentAngle("portrait", WIDE_NATURAL, 0);
    expect(orientationAt(angle, "landscape")).toBe("portrait");
    expect(contentBox(WIDE_NATURAL, syntheticRotation(angle, 0))).toEqual({
      width: 800,
      height: 1280,
    });
  });
});

test.describe("freezing across OS rotations", () => {
  test("a tilt that flips the OS to portrait leaves the landscape content where it was", () => {
    // Playing landscape with the OS in landscape (angle 90): synthetic 0.
    expect(syntheticRotation(90, 90)).toBe(0);
    // The OS flips to portrait mid-tilt: content angle stands, CSS counter-rotates.
    const angle = reconcileContentAngle(90, PHONE_PORTRAIT, 0);
    expect(angle).toBe(90);
    expect(syntheticRotation(angle, 0)).toBe(90);
    expect(contentBox(PHONE_PORTRAIT, 90)).toEqual(PHONE_LANDSCAPE);
  });

  test("the OS turning the phone around within the same orientation is adopted", () => {
    // Player turns the phone 180° in landscape and the OS follows: content
    // glued to the device would now be upside down for them.
    expect(reconcileContentAngle(90, PHONE_LANDSCAPE, 270)).toBe(270);
    expect(syntheticRotation(270, 270)).toBe(0);
  });

  test("a portrait controller survives the OS going landscape", () => {
    expect(reconcileContentAngle(0, PHONE_LANDSCAPE, 90)).toBe(0);
    expect(syntheticRotation(0, 90)).toBe(270);
    expect(contentBox(PHONE_LANDSCAPE, 270)).toEqual(PHONE_PORTRAIT);
    expect(reconcileContentAngle(0, PHONE_LANDSCAPE, 270)).toBe(0);
    expect(syntheticRotation(0, 270)).toBe(90);
  });

  test("a quarter turn swaps the box, a half turn keeps it", () => {
    expect(contentBox(PHONE_PORTRAIT, 0)).toEqual(PHONE_PORTRAIT);
    expect(contentBox(PHONE_PORTRAIT, 180)).toEqual(PHONE_PORTRAIT);
    expect(contentBox(PHONE_PORTRAIT, 270)).toEqual(PHONE_LANDSCAPE);
  });
});

test.describe("manual rotate cycle", () => {
  test("locks restrict what the chip can cycle through", () => {
    expect(allowedOrientations("landscape")).toEqual(["landscape"]);
    expect(allowedOrientations(null)).toEqual(["portrait", "landscape"]);
    expect(contentAngleCycle("landscape", "portrait")).toEqual([90, 270]);
    expect(contentAngleCycle("portrait", "portrait")).toEqual([0]);
    expect(contentAngleCycle(null, "portrait")).toEqual([90, 270, 0]);
  });

  test("cycles both landscape holds and upright portrait, wrapping around", () => {
    expect(nextContentAngle(0, null, "portrait")).toBe(90);
    expect(nextContentAngle(90, null, "portrait")).toBe(270);
    expect(nextContentAngle(270, null, "portrait")).toBe(0);
    expect(nextContentAngle(90, "landscape", "portrait")).toBe(270);
    expect(nextContentAngle(270, "landscape", "portrait")).toBe(90);
  });

  test("an angle outside the cycle (upside-down portrait) restarts it", () => {
    expect(nextContentAngle(180, null, "portrait")).toBe(90);
  });
});

test.describe("pointer deltas through the synthetic rotation", () => {
  test("no rotation passes deltas through", () => {
    expect(rotateDelta(3, -4, 0)).toEqual({ dx: 3, dy: -4 });
  });

  test("dragging toward the content's top reads as up under every rotation", () => {
    // Content rotated 90° clockwise: its top edge is on the client's right,
    // so a drag to the client's right is "up" for the control.
    expect(rotateDelta(10, 0, 90)).toEqual({ dx: 0, dy: -10 });
    // 270°: the content's top is on the client's left.
    expect(rotateDelta(-10, 0, 270)).toEqual({ dx: -0, dy: -10 });
    // 180°: everything is mirrored.
    expect(rotateDelta(0, 10, 180)).toEqual({ dx: -0, dy: -10 });
  });

  test("rotating and un-rotating round-trips", () => {
    const angles: ScreenAngle[] = [0, 90, 180, 270];
    for (const angle of angles) {
      const { dx, dy } = rotateDelta(7, -3, angle);
      // Applying the CSS rotation to the local delta returns the client one.
      const back = rotateDelta(dx, dy, ((360 - angle) % 360) as ScreenAngle);
      expect(back.dx).toBeCloseTo(7);
      expect(back.dy).toBeCloseTo(-3);
    }
  });

  test("pointerDeltaInFrame undoes the rotation and the bounding rect's scale", () => {
    // A 100×100 pad drawn at half scale and rotated a quarter turn: its
    // bounding rect is a 50×50 box; a touch 10 client px right of center is
    // 20 local px toward the pad's top.
    const rect = { left: 100, top: 100, width: 50, height: 50 };
    expect(
      pointerDeltaInFrame(rect, { width: 100, height: 100 }, 90, 135, 125),
    ).toEqual({ dx: 0, dy: -20 });
    // A 120×60 pill rotated a quarter turn spans 60 client px wide.
    const pill = { left: 0, top: 0, width: 60, height: 120 };
    expect(
      pointerDeltaInFrame(pill, { width: 120, height: 60 }, 90, 30, 90),
    ).toEqual({ dx: 30, dy: -0 });
  });
});

test.describe("safe-area insets through the synthetic rotation", () => {
  const insets = { top: 47, right: 0, bottom: 34, left: 0 };

  test("upright keeps the physical insets", () => {
    expect(rotateInsets(insets, 0)).toEqual(insets);
  });

  test("a quarter turn puts the notch on the content's side", () => {
    // Content rotated 90° clockwise: the device's top edge (the notch) lies
    // along the content's left, the home indicator along its right.
    expect(rotateInsets(insets, 90)).toEqual({
      top: 0,
      right: 34,
      bottom: 0,
      left: 47,
    });
    expect(rotateInsets(insets, 270)).toEqual({
      top: 0,
      right: 47,
      bottom: 0,
      left: 34,
    });
  });

  test("a half turn swaps top and bottom", () => {
    expect(rotateInsets(insets, 180)).toEqual({
      top: 34,
      right: 0,
      bottom: 47,
      left: 0,
    });
  });
});
