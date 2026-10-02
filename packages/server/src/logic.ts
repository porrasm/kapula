import crypto from "crypto";
import {
  GAMEPAD_CODE_ALPHABET,
  GAMEPAD_CODE_LENGTH,
  GAMEPAD_PLAYER_NAME_MAX_LENGTH,
  gamepadPlayerNameSchema,
  getSessionColors,
  normalizeGamepadPlayerName,
  type GamepadRosterEntry,
  type GamepadSessionConfig,
  type GamepadSessionState,
} from "@kapula/protocol";

/**
 * Pure session rules, kept free of database and WebSocket imports so the unit
 * tests can exercise them directly.
 */

export const generateGamepadCode = (): string => {
  let code = "";
  for (let i = 0; i < GAMEPAD_CODE_LENGTH; i++) {
    code += GAMEPAD_CODE_ALPHABET[crypto.randomInt(GAMEPAD_CODE_ALPHABET.length)];
  }
  return code;
};

export const generateGamepadToken = (): string =>
  crypto.randomBytes(32).toString("hex");

/**
 * Driver keys let a standalone driver create its own session (see GAMEPAD.md
 * "Driver keys"). The `gpk_` prefix makes a leaked key recognizable in logs
 * and secret scanners; the value after it is 32 random bytes.
 */
export const GAMEPAD_DRIVER_KEY_PREFIX = "gpk_";
/** Characters of the plain key kept for display in the key list. */
export const GAMEPAD_DRIVER_KEY_DISPLAY_CHARS = 8;

export const generateDriverKey = (): string =>
  `${GAMEPAD_DRIVER_KEY_PREFIX}${crypto.randomBytes(32).toString("hex")}`;

/**
 * Keys are stored as their SHA-256 hash, so the plain value exists only in
 * the creation response and the driver's own config. Lookup hashes what was
 * presented and matches on that, never comparing secrets byte by byte.
 */
export const hashDriverKey = (key: string): string =>
  crypto.createHash("sha256").update(key, "utf8").digest("hex");

/** What the key list shows: enough to tell two keys apart, not to use one. */
export const driverKeyDisplayPrefix = (key: string): string =>
  key.slice(0, GAMEPAD_DRIVER_KEY_PREFIX.length + GAMEPAD_DRIVER_KEY_DISPLAY_CHARS);

/**
 * Fixed-window per-key rate limiter (no timers; windows roll over lazily on
 * the next attempt). The clock is injectable so the unit tests can cover the
 * window logic without waiting it out for real.
 */
export const createRateLimiter = (params: {
  windowMs: number;
  maxAttempts: number;
  now?: () => number;
}) => {
  const now = params.now ?? Date.now;
  const attempts = new Map<string, { windowStart: number; count: number }>();
  return {
    /** Records an attempt for the key; true when the key is over the limit. */
    isLimited(key: string): boolean {
      const at = now();
      // Unbounded key sets (e.g. spoofed IPs) must not grow the map forever.
      if (attempts.size > 10_000) attempts.clear();
      const entry = attempts.get(key);
      if (!entry || at - entry.windowStart >= params.windowMs) {
        attempts.set(key, { windowStart: at, count: 1 });
        return false;
      }
      entry.count += 1;
      return entry.count > params.maxAttempts;
    },
  };
};

/**
 * The image type of a background upload, read from its magic bytes — never
 * from the Content-Type the driver claims, since the bytes are served back
 * to phones under the type decided here. Only raster formats every phone
 * browser draws are accepted; anything else (SVG with its scripts included)
 * is null.
 */
export const sniffImageType = (
  bytes: Uint8Array,
): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null => {
  const at = (offset: number, ...expected: number[]) =>
    expected.every((b, i) => bytes[offset + i] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif"; // "GIF8"
  // "RIFF" <size> "WEBP"
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) {
    return "image/webp";
  }
  return null;
};

/** Driver commands and the only transition each one is allowed to make. */
export const DRIVER_TRANSITIONS: Record<
  "start" | "pause" | "resume" | "end" | "lobby",
  { from: GamepadSessionState[]; to: GamepadSessionState }
> = {
  start: { from: ["waiting_for_players"], to: "in_progress" },
  pause: { from: ["in_progress"], to: "paused" },
  resume: { from: ["paused"], to: "in_progress" },
  end: {
    from: ["waiting_for_players", "in_progress", "paused"],
    to: "ended",
  },
  /** Back to the lobby between rounds; players ready up again. */
  lobby: { from: ["in_progress", "paused"], to: "waiting_for_players" },
};

export type PlayerReadiness = { ready: boolean; connected: boolean };

/** Returns null when the driver may start the game, else a reason. */
export const getStartError = (params: {
  state: GamepadSessionState;
  config: GamepadSessionConfig;
  players: PlayerReadiness[];
}): string | null => {
  if (params.state !== "waiting_for_players") {
    return `Cannot start from state "${params.state}"`;
  }
  // No lobby: nobody has to be there, let alone ready.
  if (params.config.skipLobby) return null;
  const connected = params.players.filter((p) => p.connected);
  if (connected.length < params.config.minPlayers) {
    if (params.config.roster) {
      // Roster sessions start only complete: every slot filled and online.
      const missing = params.config.roster.length - connected.length;
      return `Waiting for ${missing} more player(s) to join`;
    }
    return `Need at least ${params.config.minPlayers} connected player(s)`;
  }
  if (connected.some((p) => !p.ready)) {
    return "All connected players must be ready";
  }
  return null;
};

/**
 * Returns null when a new player may join, else a reason. Name and color are
 * assigned by the server at join time (see pickDefaultName/pickDefaultColor)
 * and customized later with update_profile, so joining only checks state and
 * capacity.
 */
export const getJoinError = (params: {
  state: GamepadSessionState;
  config: GamepadSessionConfig;
  activePlayers: unknown[];
}): string | null => {
  if (params.state === "not_initialized") {
    return "The game has not connected yet";
  }
  if (!acceptsJoins(params.state, params.config)) {
    return "The session is not accepting new players";
  }
  if (params.activePlayers.length >= params.config.maxPlayers) {
    return "The session is full";
  }
  return null;
};

/**
 * Which states admit a new player: the lobby always, a running game only when
 * the driver opted in with `allowLateJoin` (or `skipLobby`, which implies
 * it) — and never in a roster session, where the player set is fixed by the
 * roster.
 */
export const acceptsJoins = (
  state: GamepadSessionState,
  config: GamepadSessionConfig,
): boolean => {
  if (state === "waiting_for_players") return true;
  if (state !== "in_progress" && state !== "paused") return false;
  return (config.allowLateJoin || config.skipLobby) && !isRosterSession(config);
};

/** Whether the driver predefined the players (names and colors are fixed). */
export const isRosterSession = (config: GamepadSessionConfig): boolean =>
  config.roster !== undefined;

/**
 * Resolves which roster slot a joining player asked for. Returns the slot,
 * or an error reason: roster sessions require a pick, the pick must exist
 * (case-insensitive) and nobody may hold it already.
 */
export const pickRosterSlot = (params: {
  config: GamepadSessionConfig;
  activePlayers: { name: string }[];
  name: string | undefined;
}): { slot: GamepadRosterEntry } | { error: string } => {
  const roster = params.config.roster ?? [];
  if (!params.name) {
    return { error: "Pick which player you are" };
  }
  const wanted = normalizeGamepadPlayerName(params.name).toLowerCase();
  const slot = roster.find((entry) => entry.name.toLowerCase() === wanted);
  if (!slot) {
    return { error: "That player is not in this game" };
  }
  const taken = params.activePlayers.some(
    (p) => p.name.toLowerCase() === slot.name.toLowerCase(),
  );
  if (taken) {
    return { error: "That player has already joined" };
  }
  return { slot };
};

/**
 * Returns null when a player may take this name/color, else a reason. Used by
 * update_profile; `otherPlayers` must exclude the player being updated.
 */
export const getProfileError = (params: {
  config: GamepadSessionConfig;
  otherPlayers: { name: string; color: string }[];
  name: string;
  color: string;
}): string | null => {
  if (!getSessionColors(params.config).includes(params.color)) {
    return "Pick a color from the session's palette";
  }
  const nameLower = params.name.toLowerCase();
  if (params.otherPlayers.some((p) => p.name.toLowerCase() === nameLower)) {
    return "That name is already taken";
  }
  if (params.otherPlayers.some((p) => p.color === params.color)) {
    return "That color is already taken";
  }
  return null;
};

/**
 * Name assigned at join: the preferred name (e.g. the host's account name)
 * when it is valid and free, otherwise "Player N" with the first free N.
 */
export const pickDefaultName = (
  takenNames: string[],
  preferred?: string,
): string => {
  const taken = new Set(takenNames.map((n) => n.toLowerCase()));
  if (preferred) {
    const parsed = gamepadPlayerNameSchema.safeParse(
      normalizeGamepadPlayerName(preferred).slice(
        0,
        GAMEPAD_PLAYER_NAME_MAX_LENGTH,
      ),
    );
    if (parsed.success && !taken.has(parsed.data.toLowerCase())) {
      return parsed.data;
    }
  }
  for (let n = 1; ; n++) {
    const candidate = `Player ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
};

/** Color assigned at join: the first palette color nobody holds. */
export const pickDefaultColor = (
  config: GamepadSessionConfig,
  takenColors: string[],
): string | null => {
  const taken = new Set(takenColors);
  return getSessionColors(config).find((color) => !taken.has(color)) ?? null;
};

/** Ready toggling is a lobby action only. */
export const canSetReady = (state: GamepadSessionState): boolean =>
  state === "waiting_for_players";

/**
 * Name/color changes are a lobby action only — and never in a roster session,
 * where the driver fixed both.
 */
export const canUpdateProfile = (
  state: GamepadSessionState,
  config?: GamepadSessionConfig,
): boolean =>
  state === "waiting_for_players" && !(config && isRosterSession(config));

/**
 * Schema changes are allowed in any live state — the player's choice of
 * controls is theirs to make mid-game, not something the driver's pause
 * gates. Only a session that is not running yet or already over refuses.
 */
export const canSelectSchema = (state: GamepadSessionState): boolean =>
  state === "waiting_for_players" ||
  state === "in_progress" ||
  state === "paused";

/**
 * Whether a client message counts as session activity (the 24 h idle clock).
 * Everything a human does counts; keepalive pings must not, or a phone left
 * open in a lobby would keep its session alive forever.
 */
export const countsAsActivity = (messageType: string): boolean =>
  messageType !== "ping";

/** Input is relayed only while the game runs. */
export const canSendInput = (state: GamepadSessionState): boolean =>
  state === "in_progress";
