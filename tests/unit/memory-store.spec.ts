import { createKapulaMemoryStore } from "@kapula/server";
import { describeKapulaStoreConformance } from "@kapula/server/testing";

describeKapulaStoreConformance("memory", async () => {
  let clock = 1_700_000_000_000;
  return {
    store: createKapulaMemoryStore({ now: () => clock }),
    ownerId: 1,
    otherUserId: 2,
    isolated: true,
    advanceClock: (ms) => {
      clock += ms;
    },
  };
});
