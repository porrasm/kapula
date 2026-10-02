import type { KapulaSessionState } from "@kapula/protocol";

/**
 * The player's session credential lives in localStorage so an accidentally
 * closed tab (or a phone that locked) silently rejoins the same player slot.
 */
export type StoredPlayer = {
  sessionId: string;
  playerId: string;
  token: string;
};

const STORAGE_KEY = "gamepad:player";

export const loadStoredPlayer = (): StoredPlayer | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPlayer>;
    if (!parsed.sessionId || !parsed.playerId || !parsed.token) return null;
    return {
      sessionId: parsed.sessionId,
      playerId: parsed.playerId,
      token: parsed.token,
    };
  } catch {
    return null;
  }
};

export const saveStoredPlayer = (player: StoredPlayer) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(player));
  } catch {
    /* private mode etc. — the session just won't survive a tab close */
  }
};

export const clearStoredPlayer = () => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
};

/**
 * Whether the credential is dead for good and must be discarded now, not on
 * the "Back to start" tap — a player who just closes the tab from the ended
 * screen must not find a ghost "game in progress" card on their next visit.
 * True on a live `ended` state and on the closes that mean the session or
 * token is gone: 4004 (not found / dead token), 4005 (session ended) and
 * 4011 (removed from the session — the slot and token are freed, so the
 * credential leads nowhere). Other fatal closes keep the credential: 4010
 * (controller opened on another device) is recoverable from this device, and
 * 4008 (rate limited) leaves a live session behind.
 */
const DEAD_CREDENTIAL_CLOSE_CODES = [4004, 4005, 4011];

export const shouldDiscardStoredPlayer = (
  snapshotState: KapulaSessionState | null,
  fatalCloseCode: number | null,
): boolean =>
  snapshotState === "ended" ||
  (fatalCloseCode !== null &&
    DEAD_CREDENTIAL_CLOSE_CODES.includes(fatalCloseCode));
