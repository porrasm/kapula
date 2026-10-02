import {
  KAPULA_DRIVER_LOST_TIMEOUT_MS,
  type KapulaStateChangeReason,
} from "@kapula/protocol";

/**
 * Copy for a session that went away, kept free of React so the unit tests
 * can pin it down. An ended session is never a screen of its own: players
 * land back on the start page with one of these lines, hosts see one on the
 * create form.
 */

export const DRIVER_LOST_MINUTES = Math.round(
  KAPULA_DRIVER_LOST_TIMEOUT_MS / 60_000,
);

/**
 * What the landing page tells a player whose session just went away. The
 * server announces the reason in the final state_changed before closing the
 * socket; a dead token (close 4004) means the session ended while we were
 * away and the reason is unknown.
 */
export const sessionGoneMessage = (
  reason: KapulaStateChangeReason | null,
  closeCode: number | null,
): string => {
  // A kick closes the socket while the session runs on, so there is no
  // state_changed for it — and the last one we did see (a start, a resume)
  // says nothing about why this player is gone. The close code wins.
  if (closeCode === 4011) {
    return "You were removed from the session. You can join again with the join code.";
  }
  switch (reason) {
    case "driver_lost":
      return "The game lost its connection and the session was closed. Ask the host for a new join code.";
    case "inactivity":
      return "The session was closed after a long time without activity.";
    case "driver_command":
    case "host_ended":
      return "The session ended. Thanks for playing!";
    default:
      return closeCode === 4004
        ? "That session no longer exists. Join a new one with a join code."
        : "The session ended. Thanks for playing!";
  }
};

/** Shown in the player views while the driver is away. */
export const DRIVER_AWAY_NOTICE = `The game lost its connection. If it doesn't come back within ${DRIVER_LOST_MINUTES} minutes, the session closes.`;

/** One line for the host about why the session they were watching is gone. */
export const sessionEndedNote = (
  reason: KapulaStateChangeReason | null,
): string => {
  switch (reason) {
    case "driver_lost":
      return `Your session was closed because the game stayed disconnected for ${DRIVER_LOST_MINUTES} minutes. Create a new one to play again — a game that remembers its players can set it up with the same roster.`;
    case "inactivity":
      return "Your session was closed after a long time without activity.";
    default:
      return "Your session has ended.";
  }
};
