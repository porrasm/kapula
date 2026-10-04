import type { KapulaInputValue, KapulaPlayerClientMessage } from "@kapula/protocol";
import type { SeqCounter } from "./seq-counter.js";

/**
 * The full controller state behind the input sender, without timers or
 * React. `set` records a value the player produced; `seed` records one the
 * driver pushed (it already knows): neither touches the seq counter, and
 * only `frame` sends, so a seeded value rides on the next real frame
 * instead of being overwritten by a stale one.
 */
export const createInputState = (
  seq: () => SeqCounter,
  send: (msg: KapulaPlayerClientMessage) => void,
) => {
  const controls: Record<string, KapulaInputValue> = {};
  return {
    set: (id: string, value: KapulaInputValue) => {
      controls[id] = value;
    },
    seed: (id: string, value: KapulaInputValue) => {
      controls[id] = value;
    },
    frame: () =>
      send({ type: "input", seq: seq().next(), controls: { ...controls } }),
  };
};
