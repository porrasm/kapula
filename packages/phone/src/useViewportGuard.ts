import { useEffect } from "react";

/**
 * Keeps where the controller paints and where touches land in agreement.
 *
 * The session screen is a stack of position: fixed layers. Two phone
 * behaviours — both worst in a home-screen (standalone) web app on iOS —
 * split those layers from hit-testing, so presses land a few dozen pixels
 * off the buttons:
 *
 * - Keyboard scroll residue: focusing the lobby's name field makes iOS
 *   scroll the window to reveal the input, and after the keyboard goes it
 *   often leaves that scroll in place. Fixed layers then paint offset by the
 *   leftover scroll from where touches are resolved.
 * - Pinch-zoom residue: Safari ignores user-scalable=no, and a stray pinch
 *   on the lobby carries a zoomed visual viewport into the game screen.
 *
 * The guards below remove the residue instead of living with it: scroll
 * back to the origin whenever the window is scrolled with no text field
 * focused (while the keyboard is up iOS scrolls on purpose — the reset waits
 * for the blur), and swallow pinch gestures at the source.
 */

/** True for elements that summon the on-screen keyboard. */
export const isTextEntry = (
  el: { tagName: string; isContentEditable?: boolean } | null,
): boolean => {
  if (!el) return false;
  const tag = el.tagName.toUpperCase();
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable === true
  );
};

export const resetWindowScroll = () => {
  if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
};

// The keyboard animates away after a blur; a second reset after it is gone
// catches the scroll iOS applies during the animation.
const KEYBOARD_DISMISS_MS = 350;

/**
 * For screens made of fixed layers: any window scroll is residue, undo it.
 * Mount = the screen came up (possibly over a scrolled landing page); blur
 * = the keyboard is going; viewport events = iOS settling after either.
 */
export const useFixedLayerScrollGuard = () => {
  useEffect(() => {
    resetWindowScroll();

    const resetUnlessTyping = () => {
      if (isTextEntry(document.activeElement)) return;
      resetWindowScroll();
    };
    let dismissTimer: number | undefined;
    const onFocusOut = () => {
      window.setTimeout(resetUnlessTyping, 0);
      window.clearTimeout(dismissTimer);
      dismissTimer = window.setTimeout(resetUnlessTyping, KEYBOARD_DISMISS_MS);
    };

    const vv = window.visualViewport;
    document.addEventListener("focusout", onFocusOut);
    window.addEventListener("scroll", resetUnlessTyping);
    vv?.addEventListener("resize", resetUnlessTyping);
    vv?.addEventListener("scroll", resetUnlessTyping);
    return () => {
      window.clearTimeout(dismissTimer);
      document.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("scroll", resetUnlessTyping);
      vv?.removeEventListener("resize", resetUnlessTyping);
      vv?.removeEventListener("scroll", resetUnlessTyping);
    };
  }, []);
};

/**
 * Blocks pinch zoom for the whole app. The viewport meta asks for it, but
 * Safari honours only a preventDefault on its proprietary gesture events (and,
 * on older iOS, a multi-touch touchmove); touch-action: pan-x pan-y in
 * index.html covers the other browsers.
 */
export const useNoPinchZoom = () => {
  useEffect(() => {
    const block = (e: Event) => e.preventDefault();
    const blockMultiTouch = (e: TouchEvent) => {
      if (e.touches.length > 1) e.preventDefault();
    };
    const opts: AddEventListenerOptions = { passive: false };
    document.addEventListener("gesturestart", block, opts);
    document.addEventListener("gesturechange", block, opts);
    document.addEventListener("touchmove", blockMultiTouch, opts);
    return () => {
      document.removeEventListener("gesturestart", block);
      document.removeEventListener("gesturechange", block);
      document.removeEventListener("touchmove", blockMultiTouch);
    };
  }, []);
};
