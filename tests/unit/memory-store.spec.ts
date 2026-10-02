import { createMemoryGamepadStore } from "@kapula/server";
import { describeGamepadStoreConformance } from "@kapula/server/testing";

describeGamepadStoreConformance("memory", async () => {
  let clock = 1_700_000_000_000;
  return {
    store: createMemoryGamepadStore({ now: () => clock }),
    ownerId: 1,
    otherUserId: 2,
    isolated: true,
    advanceClock: (ms) => {
      clock += ms;
    },
  };
});
