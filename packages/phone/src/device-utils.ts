import type { KapulaDeviceInfo } from "@kapula/protocol";

/** Shorter viewport side (CSS px) from which a device counts as a tablet. */
export const TABLET_MIN_SHORT_SIDE = 600;

export const deviceInfoFor = (
  width: number,
  height: number,
  touch: boolean,
  motion: boolean,
): KapulaDeviceInfo => {
  const w = Math.max(0, Math.round(width));
  const h = Math.max(0, Math.round(height));
  return {
    class: Math.min(w, h) >= TABLET_MIN_SHORT_SIDE ? "tablet" : "phone",
    width: w,
    height: h,
    touch,
    motion,
  };
};
