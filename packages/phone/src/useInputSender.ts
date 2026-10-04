import { useCallback, useEffect, useRef } from "react";
import type { KapulaInputValue, KapulaPlayerClientMessage } from "@kapula/protocol";
import { THROTTLE_MS } from "./input-throttle.js";
import { createInputState } from "./input-state.js";
import { createSeqCounter, type SeqCounter } from "./seq-counter.js";

export { THROTTLE_MS, POINTER_THROTTLE_MS, inputThrottleMs } from "./input-throttle.js";

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
  send: (msg: KapulaPlayerClientMessage) => void,
  enabled: boolean,
  seq?: SeqCounter,
  throttleMs = THROTTLE_MS,
) => {
  const ownSeqRef = useRef<SeqCounter | null>(null);
  const counter = seq ?? (ownSeqRef.current ??= createSeqCounter());
  const seqRef = useRef(counter);
  seqRef.current = counter;
  const sendRef = useRef(send);
  const stateRef = useRef<ReturnType<typeof createInputState> | null>(null);
  stateRef.current ??= createInputState(
    () => seqRef.current,
    (msg) => sendRef.current(msg),
  );
  const timerRef = useRef<number | null>(null);
  const lastSentRef = useRef(0);
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
    stateRef.current!.frame();
  }, []);

  const setControl = useCallback(
    (id: string, value: KapulaInputValue, immediate: boolean) => {
      stateRef.current!.set(id, value);
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

  /** Records a driver-pushed value in the state: no frame, no seq. */
  const seedControl = useCallback((id: string, value: KapulaInputValue) => {
    stateRef.current!.seed(id, value);
  }, []);

  return { setControl, seedControl };
};
