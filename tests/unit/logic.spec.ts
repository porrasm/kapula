import { test, expect } from "@playwright/test";
import {
  KAPULA_CODE_ALPHABET,
  KAPULA_CODE_LENGTH,
  KAPULA_DEFAULT_COLORS,
  kapulaSessionConfigSchema,
} from "@kapula/protocol";
import {
  DRIVER_TRANSITIONS,
  canSelectSchema,
  createRateLimiter,
  canSendInput,
  acceptsJoins,
  canSetReady,
  canUpdateProfile,
  countsAsActivity,
  driverKeyDisplayPrefix,
  generateDriverKey,
  hashDriverKey,
  generateKapulaCode,
  generateKapulaToken,
  getJoinError,
  getProfileError,
  getStartError,
  isRosterSession,
  pickDefaultColor,
  pickDefaultName,
  pickRosterSlot,
} from "@kapula/server";

const config = kapulaSessionConfigSchema.parse({
  minPlayers: 2,
  maxPlayers: 3,
});

test.describe("code and token generation", () => {
  test("codes use only the unambiguous alphabet", () => {
    for (let i = 0; i < 100; i++) {
      const code = generateKapulaCode();
      expect(code).toHaveLength(KAPULA_CODE_LENGTH);
      for (const char of code) {
        expect(KAPULA_CODE_ALPHABET).toContain(char);
      }
    }
  });

  test("tokens are long and unique", () => {
    const a = generateKapulaToken();
    const b = generateKapulaToken();
    expect(a).toHaveLength(64);
    expect(a).not.toBe(b);
  });
});

test.describe("getStartError", () => {
  const player = (ready: boolean, connected: boolean) => ({ ready, connected });

  test("only starts from the lobby", () => {
    expect(
      getStartError({ state: "in_progress", config, players: [] }),
    ).toContain("in_progress");
    expect(
      getStartError({ state: "not_initialized", config, players: [] }),
    ).toBeTruthy();
  });

  test("requires minPlayers connected players", () => {
    expect(
      getStartError({
        state: "waiting_for_players",
        config,
        players: [player(true, true)],
      }),
    ).toContain("at least 2");
  });

  test("requires every connected player to be ready", () => {
    expect(
      getStartError({
        state: "waiting_for_players",
        config,
        players: [player(true, true), player(false, true)],
      }),
    ).toContain("ready");
  });

  test("an empty session can never start", () => {
    const solo = kapulaSessionConfigSchema.parse({ minPlayers: 1 });
    expect(
      getStartError({ state: "waiting_for_players", config: solo, players: [] }),
    ).toContain("at least 1");
    // Everyone present but nobody connected counts as nobody.
    expect(
      getStartError({
        state: "waiting_for_players",
        config: solo,
        players: [player(true, false), player(true, false)],
      }),
    ).toContain("at least 1");
  });

  test("ignores disconnected players", () => {
    expect(
      getStartError({
        state: "waiting_for_players",
        config,
        players: [player(true, true), player(true, true), player(false, false)],
      }),
    ).toBeNull();
  });
});

test.describe("roster sessions", () => {
  const rosterConfig = kapulaSessionConfigSchema.parse({
    roster: [
      { name: "Player 1", color: "#FF6B6B" },
      { name: "Player 2", color: "#6BCB77" },
    ],
  });
  const player = (ready: boolean, connected: boolean) => ({ ready, connected });

  test("isRosterSession tells the two kinds apart", () => {
    expect(isRosterSession(rosterConfig)).toBe(true);
    expect(isRosterSession(config)).toBe(false);
  });

  test("starts only once every slot is filled, connected and ready", () => {
    expect(
      getStartError({
        state: "waiting_for_players",
        config: rosterConfig,
        players: [player(true, true)],
      }),
    ).toContain("1 more player");
    expect(
      getStartError({
        state: "waiting_for_players",
        config: rosterConfig,
        players: [player(true, true), player(true, false)],
      }),
    ).toContain("1 more player");
    expect(
      getStartError({
        state: "waiting_for_players",
        config: rosterConfig,
        players: [player(true, true), player(false, true)],
      }),
    ).toContain("ready");
    expect(
      getStartError({
        state: "waiting_for_players",
        config: rosterConfig,
        players: [player(true, true), player(true, true)],
      }),
    ).toBeNull();
  });

  test("capacity is the roster size", () => {
    expect(
      getJoinError({
        state: "waiting_for_players",
        config: rosterConfig,
        activePlayers: [{}, {}],
      }),
    ).toContain("full");
  });

  test("joining picks a free slot by name, case-insensitively", () => {
    const pick = pickRosterSlot({
      config: rosterConfig,
      activePlayers: [{ name: "Player 1" }],
      name: " player 2 ",
    });
    expect(pick).toEqual({
      slot: { name: "Player 2", color: "#6BCB77" },
    });
  });

  test("a pick is required, must exist and must be free", () => {
    expect(
      pickRosterSlot({ config: rosterConfig, activePlayers: [], name: undefined }),
    ).toHaveProperty("error");
    expect(
      pickRosterSlot({ config: rosterConfig, activePlayers: [], name: "Player 9" }),
    ).toHaveProperty("error", expect.stringContaining("not in this game"));
    expect(
      pickRosterSlot({
        config: rosterConfig,
        activePlayers: [{ name: "player 1" }],
        name: "Player 1",
      }),
    ).toHaveProperty("error", expect.stringContaining("already joined"));
  });

  test("names and colors are locked in a roster lobby", () => {
    expect(canUpdateProfile("waiting_for_players", rosterConfig)).toBe(false);
    expect(canUpdateProfile("waiting_for_players", config)).toBe(true);
  });
});

test.describe("getJoinError", () => {
  const base = {
    state: "waiting_for_players" as const,
    config,
    activePlayers: [{}],
  };

  test("allows a valid join", () => {
    expect(getJoinError(base)).toBeNull();
  });

  test("blocks joins outside the lobby", () => {
    expect(getJoinError({ ...base, state: "not_initialized" })).toBeTruthy();
    expect(getJoinError({ ...base, state: "in_progress" })).toBeTruthy();
    expect(getJoinError({ ...base, state: "paused" })).toBeTruthy();
  });

  test("enforces capacity", () => {
    expect(
      getJoinError({ ...base, activePlayers: [{}, {}, {}] }),
    ).toContain("full");
  });
});

test.describe("skipLobby", () => {
  const noLobby = kapulaSessionConfigSchema.parse({
    minPlayers: 2,
    maxPlayers: 2,
    skipLobby: true,
  });

  test("the driver may start with nobody joined or ready", () => {
    for (const players of [[], [{ ready: false, connected: true }]]) {
      expect(
        getStartError({ state: "waiting_for_players", config: noLobby, players }),
      ).toBeNull();
    }
    // Still only from the lobby.
    expect(
      getStartError({ state: "in_progress", config: noLobby, players: [] }),
    ).toContain("in_progress");
  });

  test("players may join while the game runs or is paused", () => {
    for (const state of ["waiting_for_players", "in_progress", "paused"] as const) {
      expect(getJoinError({ state, config: noLobby, activePlayers: [] })).toBeNull();
    }
    expect(
      getJoinError({ state: "in_progress", config: noLobby, activePlayers: [{}, {}] }),
    ).toContain("full");
    expect(
      getJoinError({ state: "not_initialized", config: noLobby, activePlayers: [] }),
    ).toBeTruthy();
  });

  test("defaults off and cannot be combined with a roster", () => {
    expect(kapulaSessionConfigSchema.parse({}).skipLobby).toBe(false);
    expect(
      kapulaSessionConfigSchema.safeParse({
        skipLobby: true,
        roster: [{ name: "Player 1", color: "#FF6B6B" }],
      }).success,
    ).toBe(false);
  });
});

test.describe("getProfileError", () => {
  const base = {
    config,
    otherPlayers: [{ name: "Alice", color: "#FF6B6B" }],
    name: "Bob",
    color: "#4D96FF",
  };

  test("allows a free name and color", () => {
    expect(getProfileError(base)).toBeNull();
  });

  test("names are unique case-insensitively", () => {
    expect(getProfileError({ ...base, name: "alice" })).toContain("name");
  });

  test("colors are unique and must come from the palette", () => {
    expect(getProfileError({ ...base, color: "#FF6B6B" })).toContain("color");
    expect(getProfileError({ ...base, color: "#123456" })).toContain("palette");
  });
});

test.describe("default name and color assignment", () => {
  test("numbers players from the first free slot", () => {
    expect(pickDefaultName([])).toBe("Player 1");
    expect(pickDefaultName(["Player 1", "player 2"])).toBe("Player 3");
    expect(pickDefaultName(["Player 2"])).toBe("Player 1");
  });

  test("prefers a valid free preferred name", () => {
    expect(pickDefaultName([], "Eetu")).toBe("Eetu");
    expect(pickDefaultName(["eetu"], "Eetu")).toBe("Player 1");
    // Too-long preferred names are truncated to fit, not rejected.
    expect(pickDefaultName([], "A".repeat(30))).toBe("A".repeat(16));
    // Invalid preferred names fall back to numbering.
    expect(pickDefaultName([], "🔥🔥🔥")).toBe("Player 1");
  });

  test("numbering scans densely packed rosters", () => {
    const taken = Array.from({ length: 11 }, (_, i) => `Player ${i + 1}`);
    expect(pickDefaultName(taken)).toBe("Player 12");
    // Preferred names are normalized (trim + collapse) before checking.
    expect(pickDefaultName([], "  E e tu  ")).toBe("E e tu");
  });

  test("picks the first free palette color", () => {
    const palette = ["#FF6B6B", "#4D96FF", "#6BCB77"];
    const custom = kapulaSessionConfigSchema.parse({
      maxPlayers: 3,
      colors: palette,
    });
    expect(pickDefaultColor(custom, [])).toBe("#FF6B6B");
    expect(pickDefaultColor(custom, ["#FF6B6B"])).toBe("#4D96FF");
    expect(pickDefaultColor(custom, palette)).toBeNull();
  });
});

test.describe("createRateLimiter", () => {
  // The driver setup endpoint uses this with a 60s window; the fake clock
  // lets the tests cover that window in microseconds (the e2e variant that
  // waits out the real window is opt-in, see gamepad-ws.spec.ts).
  const makeLimiter = () => {
    const clock = { at: 0 };
    const limiter = createRateLimiter({
      windowMs: 60_000,
      maxAttempts: 10,
      now: () => clock.at,
    });
    return { clock, limiter };
  };

  test("allows maxAttempts per window, then blocks", () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 10; i++) {
      expect(limiter.isLimited("ip")).toBe(false);
    }
    expect(limiter.isLimited("ip")).toBe(true);
    expect(limiter.isLimited("ip")).toBe(true);
  });

  test("keys are limited independently", () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 11; i++) limiter.isLimited("noisy");
    expect(limiter.isLimited("noisy")).toBe(true);
    expect(limiter.isLimited("quiet")).toBe(false);
  });

  test("the window is fixed from the first attempt and then rolls over", () => {
    const { clock, limiter } = makeLimiter();
    for (let i = 0; i < 11; i++) limiter.isLimited("ip");
    // Still inside the window started at t=0: blocked, and attempts while
    // blocked do not extend the window.
    clock.at = 59_999;
    expect(limiter.isLimited("ip")).toBe(true);
    // One tick later the window has passed and counting restarts fresh.
    clock.at = 60_000;
    expect(limiter.isLimited("ip")).toBe(false);
    for (let i = 0; i < 9; i++) limiter.isLimited("ip");
    expect(limiter.isLimited("ip")).toBe(true);
  });

  test("an unbounded key set is cleared instead of growing forever", () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 11; i++) limiter.isLimited("blocked");
    for (let i = 0; i <= 10_000; i++) limiter.isLimited(`spoof-${i}`);
    // The clear also forgives earlier offenders — accepted trade-off.
    expect(limiter.isLimited("blocked")).toBe(false);
  });
});

test.describe("state gates", () => {
  test("driver transition table matches the spec", () => {
    expect(DRIVER_TRANSITIONS.start.from).toEqual(["waiting_for_players"]);
    expect(DRIVER_TRANSITIONS.pause.from).toEqual(["in_progress"]);
    expect(DRIVER_TRANSITIONS.resume.from).toEqual(["paused"]);
    expect(DRIVER_TRANSITIONS.end.from).toContain("in_progress");
    expect(DRIVER_TRANSITIONS.end.from).not.toContain("not_initialized");
    // Back to the lobby from a running game, never from a fresh or dead one.
    expect(DRIVER_TRANSITIONS.lobby.to).toBe("waiting_for_players");
    expect(DRIVER_TRANSITIONS.lobby.from).toEqual(["in_progress", "paused"]);
  });

  test("late join is opt-in, and never in a roster session", () => {
    const plain = kapulaSessionConfigSchema.parse({});
    const late = kapulaSessionConfigSchema.parse({ allowLateJoin: true });
    const lateRoster = kapulaSessionConfigSchema.parse({
      allowLateJoin: true,
      roster: [
        { name: "Ada", color: KAPULA_DEFAULT_COLORS[0] },
        { name: "Grace", color: KAPULA_DEFAULT_COLORS[1] },
      ],
    });

    // The lobby always accepts; a dead or unclaimed session never does.
    for (const config of [plain, late, lateRoster]) {
      expect(acceptsJoins("waiting_for_players", config)).toBe(true);
      expect(acceptsJoins("not_initialized", config)).toBe(false);
      expect(acceptsJoins("ended", config)).toBe(false);
    }

    // A running game only with the flag — and the roster fixes the player
    // set, so a roster session ignores it.
    for (const state of ["in_progress", "paused"] as const) {
      expect(acceptsJoins(state, plain)).toBe(false);
      expect(acceptsJoins(state, late)).toBe(true);
      expect(acceptsJoins(state, lateRoster)).toBe(false);
    }

    // getJoinError says the same thing, plus capacity.
    expect(
      getJoinError({ state: "in_progress", config: plain, activePlayers: [] }),
    ).toContain("not accepting");
    expect(
      getJoinError({ state: "in_progress", config: late, activePlayers: [] }),
    ).toBeNull();
    expect(
      getJoinError({
        state: "in_progress",
        config: late,
        activePlayers: Array.from({ length: late.maxPlayers }, () => ({})),
      }),
    ).toContain("full");
  });

  test("ready is a lobby-only action", () => {
    expect(canSetReady("waiting_for_players")).toBe(true);
    expect(canSetReady("in_progress")).toBe(false);
    expect(canSetReady("paused")).toBe(false);
  });

  test("profile changes are a lobby-only action", () => {
    expect(canUpdateProfile("waiting_for_players")).toBe(true);
    expect(canUpdateProfile("in_progress")).toBe(false);
    expect(canUpdateProfile("paused")).toBe(false);
  });

  test("schemas can change at any point in a live session", () => {
    expect(canSelectSchema("waiting_for_players")).toBe(true);
    expect(canSelectSchema("paused")).toBe(true);
    expect(canSelectSchema("in_progress")).toBe(true);
    expect(canSelectSchema("not_initialized")).toBe(false);
    expect(canSelectSchema("ended")).toBe(false);
  });

  test("input flows only while the game runs", () => {
    expect(canSendInput("in_progress")).toBe(true);
    expect(canSendInput("paused")).toBe(false);
    expect(canSendInput("waiting_for_players")).toBe(false);
  });

  test("driver keys are prefixed, hashed and displayed by their head", () => {
    const key = generateDriverKey();
    // gpk_ makes a leaked key recognizable to a log scanner; 32 random bytes
    // is the credential itself.
    expect(key).toMatch(/^gpk_[0-9a-f]{64}$/);
    expect(generateDriverKey()).not.toBe(key);

    // Only the hash is ever stored, and it is stable per key.
    const hash = hashDriverKey(key);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDriverKey(key)).toBe(hash);
    expect(hashDriverKey(generateDriverKey())).not.toBe(hash);
    expect(hash).not.toContain(key.slice(4));

    // The display prefix identifies a key without being usable as one.
    const prefix = driverKeyDisplayPrefix(key);
    expect(prefix).toHaveLength(12);
    expect(key.startsWith(prefix)).toBe(true);
    expect(hashDriverKey(prefix)).not.toBe(hash);
  });

  test("keepalive pings are not session activity", () => {
    // The phone pings every 25 s while its socket is open. If that counted,
    // a controller left open in a lobby would hold the session past the 24 h
    // idle rule forever — the one thing the idle cleanup exists to prevent.
    expect(countsAsActivity("ping")).toBe(false);
    for (const type of [
      "input",
      "motion",
      "set_ready",
      "select_schema",
      "update_profile",
      "leave",
      "start",
      "pause",
      "resume",
      "end",
      "message",
    ]) {
      expect(countsAsActivity(type)).toBe(true);
    }
  });
});
