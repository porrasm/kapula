import { useEffect, useState, type CSSProperties } from "react";
import type { Insets } from "./orientation-utils.js";

/**
 * Padding for the phone's unsafe edges — status bar / notch and the home
 * indicator. index.html opts into viewport-fit=cover, so the page runs edge
 * to edge and env(safe-area-inset-*) reports what to keep clear of (0 in a
 * plain browser tab, where the browser chrome already does that).
 *
 * The session screen is a position: fixed layer, so the body padding in
 * index.html does not reach it: its top bar and its full-bleed surfaces pad
 * themselves with these.
 */
export const SAFE_AREA = {
  /** Header bars: the usual px-4 py-2, grown by the insets. */
  topBar: {
    paddingTop: "calc(0.5rem + env(safe-area-inset-top))",
    paddingBottom: "0.5rem",
    paddingLeft: "calc(1rem + env(safe-area-inset-left))",
    paddingRight: "calc(1rem + env(safe-area-inset-right))",
  },
  /** Bars below the header: px-4 grown by the side insets. */
  sides: {
    paddingLeft: "calc(1rem + env(safe-area-inset-left))",
    paddingRight: "calc(1rem + env(safe-area-inset-right))",
  },
  /**
   * Full-bleed content under the header (the controller, the lobby scroller):
   * the box shrinks in by the side and bottom insets, so the layout engine
   * never places a control under a notch or the home indicator.
   */
  edges: {
    paddingLeft: "env(safe-area-inset-left)",
    paddingRight: "env(safe-area-inset-right)",
    paddingBottom: "env(safe-area-inset-bottom)",
  },
} satisfies Record<string, CSSProperties>;

const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * The physical safe-area insets as numbers, for surfaces that rotate their
 * content: env() can only pad the physical edges, but a controller rotated
 * a quarter turn has the notch along one of its sides (see
 * `rotateInsets` in orientation-utils.ts). Read off a hidden probe element
 * padded with env(), re-read on every resize and orientation change.
 */
export const useSafeAreaInsets = (): Insets => {
  const [insets, setInsets] = useState<Insets>(NO_INSETS);
  useEffect(() => {
    const probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    Object.assign(probe.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "0",
      height: "0",
      visibility: "hidden",
      pointerEvents: "none",
      paddingTop: "env(safe-area-inset-top)",
      paddingRight: "env(safe-area-inset-right)",
      paddingBottom: "env(safe-area-inset-bottom)",
      paddingLeft: "env(safe-area-inset-left)",
    });
    document.body.appendChild(probe);
    const read = () => {
      const s = getComputedStyle(probe);
      const next: Insets = {
        top: parseFloat(s.paddingTop) || 0,
        right: parseFloat(s.paddingRight) || 0,
        bottom: parseFloat(s.paddingBottom) || 0,
        left: parseFloat(s.paddingLeft) || 0,
      };
      setInsets((prev) =>
        prev.top === next.top &&
        prev.right === next.right &&
        prev.bottom === next.bottom &&
        prev.left === next.left
          ? prev
          : next,
      );
    };
    read();
    window.addEventListener("resize", read);
    screen.orientation?.addEventListener("change", read);
    return () => {
      window.removeEventListener("resize", read);
      screen.orientation?.removeEventListener("change", read);
      probe.remove();
    };
  }, []);
  return insets;
};
