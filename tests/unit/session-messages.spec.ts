import { test, expect } from "@playwright/test";
import {
  DRIVER_AWAY_NOTICE,
  DRIVER_LOST_MINUTES,
  sessionEndedNote,
  sessionGoneMessage,
} from "@kapula/phone/utils";

/**
 * An ended session is never a screen: players are sent back to the start
 * page with one line explaining why. The line must tell a lost game (ask
 * the host for a new code) apart from a normal end.
 */
test.describe("session copy", () => {
  test("a lost driver tells the player to get a new join code", () => {
    expect(sessionGoneMessage("driver_lost", 4005)).toContain("new join code");
    expect(sessionEndedNote("driver_lost")).toContain(
      `${DRIVER_LOST_MINUTES} minutes`,
    );
  });

  test("a normal end is just a goodbye", () => {
    for (const reason of ["driver_command", "host_ended"] as const) {
      expect(sessionGoneMessage(reason, 4005)).toContain("Thanks");
    }
    expect(sessionEndedNote("driver_command")).toContain("ended");
  });

  test("a dead token without a reason says the session is gone", () => {
    expect(sessionGoneMessage(null, 4004)).toContain("no longer exists");
    expect(sessionGoneMessage(null, 4005)).toContain("ended");
  });

  test("a kicked player is told so, whatever happened before", () => {
    // The session runs on after a kick, so there is no state_changed for it:
    // the last reason we saw is stale and the 4011 close must win.
    expect(sessionGoneMessage(null, 4011)).toContain("removed");
    for (const reason of ["driver_command", "host_ended", "driver_lost"] as const) {
      expect(sessionGoneMessage(reason, 4011)).toContain("removed");
    }
    // ...and it says how to come back: a kick is not a ban.
    expect(sessionGoneMessage(null, 4011)).toContain("join code");
  });

  test("the driver-away notice mentions the timeout", () => {
    expect(DRIVER_LOST_MINUTES).toBe(3);
    expect(DRIVER_AWAY_NOTICE).toContain("3 minutes");
  });
});
