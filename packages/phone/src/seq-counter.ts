/**
 * Input `seq` counter — owned by the phone, one per player session.
 *
 * Every input frame carries a `seq`; the driver keeps only the highest one
 * per player, and the server relays frames as sent while dropping any whose
 * seq does not exceed the last relayed one. The counter therefore has to
 * keep increasing for the whole life of the player: across schema switches
 * (each of which mounts a fresh controller) and across page reloads (which
 * lose all in-memory state).
 *
 * Reloads are covered by the seed: the counter starts at the wall-clock
 * millisecond of page load and advances by 1 per frame. The server drops
 * anything above 120 frames/s (and disconnects at 600/s), so the counter
 * always advances slower than the clock, and a counter seeded at a later
 * load is always ahead of every seq the previous load could have sent. A
 * device clock that jumps backwards between reloads is the one case this
 * does not cover; the player then rejoins.
 */
export type SeqCounter = {
  /** Returns the next seq: strictly greater than every earlier return value. */
  next: () => number;
};

export const createSeqCounter = (seed: number = Date.now()): SeqCounter => {
  let seq = Math.max(0, Math.floor(seed));
  return {
    next: () => {
      seq += 1;
      return seq;
    },
  };
};
