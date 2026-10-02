import { useCallback, useEffect, useRef } from "react";
import type { GamepadInputValue, GamepadPlayerClientMessage } from "@kapula/protocol";
import { createSeqCounter, type SeqCounter } from "./seq-counter.js";

/** Joystick movement is coalesced to ~30 frames/s; button edges flush now. */
export const THROTTLE_MS = 33;

/**
 * Schemas with a pointer surface (`raw`, `touchpad`) coalesce at ~60
 * frames/s instead: a cursor driven at 30 fps visibly stutters, and the
 * server's 120 frames/s cap leaves room.
 */
export const POINTER_THROTTLE_MS = 16;

/**
 * Maintains the full controller state and sends it as sequenced snapshot
 * frames: the driver keeps only the highest seq, so a lost or reordered
 * frame is corrected by the next one instead of leaving a stale input.
 *
 * `seq` should be the player session's counter (see seq-counter.ts) so the
 * numbering survives controller remounts on schema switches; senders that
 * never reach a driver (lobby trial, help-page demo) may leave it out and
 * get a private one.
 */
export const useInputSender = (
  send: (msg: GamepadPlayerClientMessage) => void,
  enabled: boolean,
  seq?: SeqCounter,
  throttleMs = THROTTLE_MS,
) => {
  const controlsRef = useRef<Record<string, GamepadInputValue>>({});
  const ownSeqRef = useRef<SeqCounter | null>(null);
  const counter = seq ?? (ownSeqRef.current ??= createSeqCounter());
  const seqRef = useRef(counter);
  seqRef.current = counter;
  const timerRef = useRef<number | null>(null);
  const lastSentRef = useRef(0);
  const sendRef = useRef(send);
  const enabledRef = useRef(enabled);
  const throttleRef = useRef(throttleMs);
  sendRef.current = send;
  enabledRef.current = enabled;
  throttleRef.current = throttleMs;

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!enabledRef.current) return;
    lastSentRef.current = Date.now();
    sendRef.current({
      type: "input",
      seq: seqRef.current.next(),
      controls: { ...controlsRef.current },
    });
  }, []);

  const setControl = useCallback(
    (id: string, value: GamepadInputValue, immediate: boolean) => {
      controlsRef.current[id] = value;
      if (immediate) {
        flush();
        return;
      }
      if (timerRef.current !== null) return;
      const wait = Math.max(
        0,
        throttleRef.current - (Date.now() - lastSentRef.current),
      );
      timerRef.current = window.setTimeout(flush, wait);
    },
    [flush],
  );

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return { setControl };
};
