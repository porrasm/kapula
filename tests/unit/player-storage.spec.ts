import { test, expect } from "@playwright/test";
import { shouldDiscardStoredPlayer } from "@kapula/phone/utils";

/**
 * The stored credential must die the moment the session is known gone —
 * waiting for the "Back to start" tap leaves a ghost "game in progress"
 * card for players who simply close the tab from the ended screen.
 */
test.describe("shouldDiscardStoredPlayer", () => {
  test("a live ended state discards the credential", () => {
    expect(shouldDiscardStoredPlayer("ended", null)).toBe(true);
  });

  test("session-gone closes discard the credential", () => {
    expect(shouldDiscardStoredPlayer(null, 4004)).toBe(true); // dead token
    expect(shouldDiscardStoredPlayer(null, 4005)).toBe(true); // session ended
    // 4011: kicked — the slot and the token are freed, so this credential
    // leads nowhere even though the session itself runs on.
    expect(shouldDiscardStoredPlayer("in_progress", 4011)).toBe(true);
    // Racing paths deliver both signals at once.
    expect(shouldDiscardStoredPlayer("ended", 4005)).toBe(true);
  });

  test("active states without a fatal close keep the credential", () => {
    expect(shouldDiscardStoredPlayer(null, null)).toBe(false);
    expect(shouldDiscardStoredPlayer("waiting_for_players", null)).toBe(false);
    expect(shouldDiscardStoredPlayer("in_progress", null)).toBe(false);
    expect(shouldDiscardStoredPlayer("paused", null)).toBe(false);
  });

  test("recoverable fatal closes keep the credential", () => {
    // 4010: the controller was opened on another device — this device may
    // still take the slot back with the same token.
    expect(shouldDiscardStoredPlayer("in_progress", 4010)).toBe(false);
    // 4008: rate limited — the session itself is still live.
    expect(shouldDiscardStoredPlayer("in_progress", 4008)).toBe(false);
    expect(shouldDiscardStoredPlayer(null, 4001)).toBe(false);
  });
});
