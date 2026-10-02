import type { z } from "zod";
import { GENERIC_GAMEPAD_SCHEMA } from "@kapula/protocol";
import type {
  KapulaInputValue,
  KapulaMotionSample,
  KapulaServerMessage,
  KapulaSessionSnapshot,
  kapulaSessionConfigSchema,
} from "@kapula/protocol";

/** Pre-parse config shape: joystick `mode` etc. may be omitted in presets. */
type KapulaSessionConfigInput = z.input<typeof kapulaSessionConfigSchema>;
type ControlSchemaInput = NonNullable<
  KapulaSessionConfigInput["schemas"]
>[number];

/**
 * Pure state-folding helpers for the admin debug driver view, kept free of
 * React and DOM so the unit tests can exercise them directly.
 */

// --- Session config presets for the setup form ---

/**
 * The debug driver's persistent identity: what a real game generates once
 * and ships. With it, layouts a player edits on the phone come back in every
 * later debug session (per schema id), which is how the editor is tested.
 */
export const DEBUG_DRIVER_APP_UUID = "7d3a2c1e-5b64-4f0a-9c8d-2e1f0b6a4d95";

// Uses the layout hints the way a real driver would: steering is the whole
// game, so it is pinned left and large; the trigger sits under the right
// thumb. (The hints reproduce what the heuristics would pick anyway — the
// point is exercising the hint path.)
const TANK_SCHEMA: ControlSchemaInput = {
  id: "tank",
  name: "Tank",
  controls: [
    { type: "joystick", id: "drive", zone: "left", size: "large" },
    { type: "button", id: "fire", label: "Fire", zone: "right", size: "large" },
    { type: "button", id: "boost", label: "Boost", zone: "right" },
  ],
};

// Also lets a player bring a real controller (paired with the phone): the
// debug card then shows the fixed physical control set instead of the schema.
const TANK_PRESET: Partial<KapulaSessionConfigInput> = {
  game: "Tank Debug",
  driverAppUuid: DEBUG_DRIVER_APP_UUID,
  minPlayers: 1,
  maxPlayers: 8,
  allowPhysicalGamepad: true,
  schemas: [TANK_SCHEMA],
};

// Deliberately demanding: a full Xbox-style layout is far more controls than a
// phone screen comfortably fits, which makes it a good stress test for the
// controller UI. Triggers and stick clicks are plain buttons (the protocol has
// no analog-axis control) and the d-pad is a real dpad-mode joystick.
// Mixes hinted and unhinted controls: sticks, shoulders and the small
// utility buttons are pinned to their console positions while A/B/X/Y ride
// the array-order heuristic into the right-thumb diamond.
const XBOX_SCHEMA: ControlSchemaInput = {
  id: "xbox",
  name: "Xbox",
  orientation: "landscape",
  controls: [
    { type: "joystick", id: "left-stick", zone: "left" },
    { type: "joystick", id: "right-stick", zone: "right" },
    { type: "joystick", id: "dpad", mode: "dpad", zone: "left", size: "small" },
    { type: "button", id: "a", label: "A" },
    { type: "button", id: "b", label: "B" },
    { type: "button", id: "x", label: "X" },
    { type: "button", id: "y", label: "Y" },
    { type: "button", id: "lb", label: "LB", zone: "shoulder-left" },
    { type: "button", id: "rb", label: "RB", zone: "shoulder-right" },
    { type: "button", id: "lt", label: "LT", zone: "shoulder-left" },
    { type: "button", id: "rt", label: "RT", zone: "shoulder-right" },
    { type: "button", id: "ls", label: "L3", zone: "aux", size: "small" },
    { type: "button", id: "rs", label: "R3", zone: "aux", size: "small" },
    { type: "button", id: "view", label: "View", zone: "aux" },
    { type: "button", id: "menu", label: "Menu", zone: "aux" },
  ],
};

const XBOX_PRESET: Partial<KapulaSessionConfigInput> = {
  game: "Xbox Debug",
  driverAppUuid: DEBUG_DRIVER_APP_UUID,
  minPlayers: 1,
  maxPlayers: 8,
  schemas: [XBOX_SCHEMA],
};

// One of every joystick mode: x-only steering, y-only throttle, a dpad.
const RACER_SCHEMA: ControlSchemaInput = {
  id: "racer",
  name: "Racer",
  controls: [
    { type: "joystick", id: "steer", mode: "x", label: "Steer" },
    { type: "joystick", id: "throttle", mode: "y", label: "Gas" },
    { type: "joystick", id: "look", mode: "dpad", label: "Look" },
    { type: "button", id: "boost", label: "Boost" },
    { type: "button", id: "horn", label: "Horn" },
  ],
};

const RACER_PRESET: Partial<KapulaSessionConfigInput> = {
  game: "Racer Debug",
  driverAppUuid: DEBUG_DRIVER_APP_UUID,
  minPlayers: 1,
  maxPlayers: 8,
  schemas: [RACER_SCHEMA],
};

// The precision case, and the relative pad's playground: the right thumb
// aims on a pad that re-centers under every touch (lift, reposition, keep
// aiming — no drift back to a fixed center), the left thumb walks on a
// normal stick, and the trigger sits out of the way on the shoulder.
const AIM_SCHEMA: ControlSchemaInput = {
  id: "aim",
  name: "Aim",
  controls: [
    {
      type: "joystick",
      id: "aim",
      mode: "relative",
      label: "Aim",
      zone: "right",
      size: "large",
    },
    { type: "joystick", id: "move", zone: "left" },
    { type: "button", id: "fire", label: "Fire", zone: "shoulder-right" },
  ],
};

const AIM_PRESET: Partial<KapulaSessionConfigInput> = {
  game: "Aim Debug",
  driverAppUuid: DEBUG_DRIVER_APP_UUID,
  minPlayers: 1,
  maxPlayers: 8,
  schemas: [AIM_SCHEMA],
};

// Exercises the hint vocabulary the heuristics can never produce: a
// right-hand stick with buttons under the LEFT thumb (lifted above nothing),
// a landscape lock on a schema small enough to pass for one-handed, and an
// aux pill kept out of the thumb arcs.
const BRAWLER_SCHEMA: ControlSchemaInput = {
  id: "brawler",
  name: "Brawler",
  orientation: "landscape",
  controls: [
    { type: "joystick", id: "move", zone: "right", size: "large" },
    { type: "button", id: "punch", label: "Punch", zone: "left", size: "large" },
    { type: "button", id: "kick", label: "Kick", zone: "left" },
    { type: "button", id: "block", label: "Block", zone: "left" },
    { type: "button", id: "taunt", label: "Taunt", zone: "aux", size: "small" },
  ],
};

const BRAWLER_PRESET: Partial<KapulaSessionConfigInput> = {
  game: "Brawler Debug",
  driverAppUuid: DEBUG_DRIVER_APP_UUID,
  minPlayers: 1,
  maxPlayers: 8,
  schemas: [BRAWLER_SCHEMA],
};

// Every built-in layout at once, so the lobby renders
// its schema picker and layout switching can be exercised end to end.
const MULTI_PRESET: Partial<KapulaSessionConfigInput> = {
  game: "Multi Debug",
  driverAppUuid: DEBUG_DRIVER_APP_UUID,
  minPlayers: 1,
  maxPlayers: 8,
  schemas: [GENERIC_GAMEPAD_SCHEMA, TANK_SCHEMA, RACER_SCHEMA, XBOX_SCHEMA],
};

// Tilt steering next to on-screen controls; the second schema demonstrates
// the recommended pattern of a gyro-free fallback for devices without a
// usable sensor (and puts the picker's tilt badge/gating on screen).
const TILT_SCHEMA: ControlSchemaInput = {
  id: "tilt",
  name: "Tilt",
  controls: [
    { type: "gyro", id: "tilt" },
    { type: "joystick", id: "stick" },
    { type: "button", id: "fire", label: "Fire" },
  ],
};

const TILT_PRESET: Partial<KapulaSessionConfigInput> = {
  game: "Tilt Debug",
  driverAppUuid: DEBUG_DRIVER_APP_UUID,
  minPlayers: 1,
  maxPlayers: 8,
  schemas: [TILT_SCHEMA, GENERIC_GAMEPAD_SCHEMA],
};

// The emulator case: a Wii Remote is held in portrait, top edge toward the
// TV, and the raw `motion` stream is what Dolphin reconstructs the remote's
// accelerometer and MotionPlus from. Buttons follow the remote's face (A
// under the thumb, B is the trigger, 1/2 low, +/-/Home small); the dpad is
// a real dpad. The fallback schema keeps sensorless phones in the game.
const WII_SCHEMA: ControlSchemaInput = {
  id: "wii",
  name: "Wii Remote",
  orientation: "portrait",
  controls: [
    { type: "motion", id: "imu" },
    { type: "joystick", id: "dpad", mode: "dpad" },
    { type: "button", id: "a", label: "A", size: "large" },
    { type: "button", id: "b", label: "B", size: "large" },
    { type: "button", id: "one", label: "1" },
    { type: "button", id: "two", label: "2" },
    { type: "button", id: "plus", label: "+", zone: "aux", size: "small" },
    { type: "button", id: "home", label: "Home", zone: "aux", size: "small" },
    { type: "button", id: "minus", label: "−", zone: "aux", size: "small" },
  ],
};

const WII_PRESET: Partial<KapulaSessionConfigInput> = {
  game: "Wii Debug",
  driverAppUuid: DEBUG_DRIVER_APP_UUID,
  minPlayers: 1,
  maxPlayers: 4,
  schemas: [WII_SCHEMA, GENERIC_GAMEPAD_SCHEMA],
};

// The exact-layout path: an arcade cabinet's panel, every control pinned by
// x/y percentages (a stick left, a 2×3 button bank right, start top-center)
// and locked with `disallowLayoutCustomization`, so the phone offers no
// editor and applies no stored edits. Sizes and shapes still come from the
// engine (zone + size): the bank is round "primary" buttons, which a thumb
// diamond gives four of — the second row borrows the left thumb's.
const FIXED_SCHEMA: ControlSchemaInput = {
  id: "cabinet",
  name: "Cabinet",
  orientation: "landscape",
  controls: [
    { type: "joystick", id: "stick", mode: "dpad", size: "large", x: 22, y: 58 },
    { type: "button", id: "a", label: "A", zone: "right", x: 58, y: 42 },
    { type: "button", id: "b", label: "B", zone: "right", x: 72, y: 36 },
    { type: "button", id: "c", label: "C", zone: "right", x: 86, y: 42 },
    { type: "button", id: "x", label: "X", zone: "left", x: 58, y: 76 },
    { type: "button", id: "y", label: "Y", zone: "left", x: 72, y: 70 },
    { type: "button", id: "z", label: "Z", zone: "left", x: 86, y: 76 },
    { type: "button", id: "start", label: "Start", zone: "aux", x: 50, y: 8 },
  ],
};

const FIXED_PRESET: Partial<KapulaSessionConfigInput> = {
  game: "Fixed Debug",
  driverAppUuid: DEBUG_DRIVER_APP_UUID,
  minPlayers: 1,
  maxPlayers: 8,
  disallowLayoutCustomization: true,
  schemas: [FIXED_SCHEMA],
};

// The raw path: the whole controller box is one touch surface reporting
// every finger (x/y in 0–1 of the box). The second schema lays a button and
// tilt over it: fingers on the button are the button's, every other finger
// is raw. Pair it with a background image from the card below the setup.
const TOUCH_PRESET: Partial<KapulaSessionConfigInput> = {
  game: "Touch Debug",
  driverAppUuid: DEBUG_DRIVER_APP_UUID,
  minPlayers: 1,
  maxPlayers: 8,
  schemas: [
    {
      id: "touchpad",
      name: "Touchpad",
      orientation: "landscape",
      controls: [{ type: "raw", id: "touch" }],
    },
    {
      id: "touch-tilt",
      name: "Touch + tilt",
      orientation: "landscape",
      controls: [
        { type: "raw", id: "touch" },
        { type: "button", id: "fire", label: "Fire", shape: "rect" },
        { type: "gyro", id: "tilt" },
      ],
    },
  ],
};

// The remote control: a wide touchpad under the right thumb (fingers
// reported raw, 0–1 inside the pad — the driver turns them into cursor
// motion and taps), a scroll slider under the left, laptop-style
// rectangular left / right buttons, and a keyboard (submit-mode text plus
// the keys a phone keyboard lacks) on the aux row. No lobby: the debug
// driver starts the session as soon as it connects, like a real remote
// driver would, and phones land straight on the controller.
const MOUSE_SCHEMA: ControlSchemaInput = {
  id: "mouse",
  name: "Mouse",
  orientation: "landscape",
  controls: [
    { type: "touchpad", id: "pad", aspect: 1.5, zone: "right", size: "large" },
    { type: "joystick", id: "scroll", mode: "y", zone: "left" },
    { type: "button", id: "left", label: "Left", shape: "rect", zone: "left" },
    { type: "button", id: "right", label: "Right", shape: "rect", zone: "left" },
    { type: "text", id: "keyboard", label: "Type", zone: "aux" },
    { type: "button", id: "enter", label: "Enter", zone: "aux" },
    { type: "button", id: "backspace", label: "⌫", zone: "aux" },
    { type: "button", id: "escape", label: "Esc", zone: "aux" },
  ],
};

const MOUSE_PRESET: Partial<KapulaSessionConfigInput> = {
  game: "Remote Debug",
  driverAppUuid: DEBUG_DRIVER_APP_UUID,
  minPlayers: 1,
  maxPlayers: 2,
  skipLobby: true,
  schemas: [MOUSE_SCHEMA],
};

// The party-game path: a free-text answer typed on the player's own
// keyboard (sent whole on Send / Enter as a `text` message), next to two
// buttons for voting.
const QUIZ_PRESET: Partial<KapulaSessionConfigInput> = {
  game: "Quiz Debug",
  driverAppUuid: DEBUG_DRIVER_APP_UUID,
  minPlayers: 1,
  maxPlayers: 8,
  schemas: [
    {
      id: "quiz",
      name: "Quiz",
      orientation: "portrait",
      controls: [
        { type: "text", id: "answer", label: "Answer", maxLength: 80, size: "large" },
        { type: "button", id: "yes", label: "Yes", shape: "rect" },
        { type: "button", id: "no", label: "No", shape: "rect" },
      ],
    },
  ],
};

// The recovery path: a game that already knows who is playing hands the
// names and colors back at setup, and joining players only pick their slot.
const ROSTER_PRESET: Partial<KapulaSessionConfigInput> = {
  game: "Roster Debug",
  driverAppUuid: DEBUG_DRIVER_APP_UUID,
  schemas: [TANK_SCHEMA],
  roster: [
    { name: "Player 1", color: "#FF6B6B" },
    { name: "Player 2", color: "#6BCB77" },
    { name: "Player 3", color: "#FFD93D" },
  ],
};

export const DEBUG_PRESETS: { key: string; label: string; config: object }[] = [
  { key: "generic", label: "Generic", config: {} },
  { key: "tank", label: "Tank", config: TANK_PRESET },
  { key: "xbox", label: "Xbox", config: XBOX_PRESET },
  { key: "racer", label: "Racer", config: RACER_PRESET },
  { key: "brawler", label: "Brawler", config: BRAWLER_PRESET },
  { key: "aim", label: "Aim", config: AIM_PRESET },
  { key: "tilt", label: "Tilt", config: TILT_PRESET },
  { key: "wii", label: "Wii", config: WII_PRESET },
  { key: "multi", label: "Multi", config: MULTI_PRESET },
  { key: "fixed", label: "Fixed", config: FIXED_PRESET },
  { key: "touch", label: "Touch", config: TOUCH_PRESET },
  { key: "mouse", label: "Remote", config: MOUSE_PRESET },
  { key: "quiz", label: "Quiz", config: QUIZ_PRESET },
  { key: "roster", label: "Roster", config: ROSTER_PRESET },
];

/**
 * What a real game does after losing a session: set up a new one with the
 * same config and the players it remembers as a roster, so everyone just
 * picks themselves. Returns null when nobody had joined (nothing to recover;
 * a plain new session is the right move).
 */
export const buildRecoveryConfig = (
  snapshot: KapulaSessionSnapshot,
): KapulaSessionConfigInput | null => {
  if (snapshot.players.length === 0) return null;
  const { minPlayers: _min, maxPlayers: _max, ...rest } = snapshot.config;
  return {
    ...rest,
    roster: snapshot.players.map((p) => ({ name: p.name, color: p.color })),
  };
};

/** The raw motion stream's tail: newest sample and recent sample arrivals. */
export type DebugPlayerMotion = {
  last: KapulaMotionSample;
  /** Arrival timestamps (ms) of recent samples, oldest first. */
  recentAt: number[];
};

/** Latest input frame per player, plus recent arrival times for a rate readout. */
export type DebugPlayerInput = {
  seq: number;
  controls: Record<string, KapulaInputValue>;
  /** Arrival timestamps (ms) of recent frames, oldest first. */
  recentAt: number[];
  /** Present once a `motion` batch has arrived. */
  motion?: DebugPlayerMotion;
  /** The last text each `text` control sent, by control id. */
  texts?: Record<string, string>;
};

export type DebugInputs = Record<string, DebugPlayerInput>;

const RATE_WINDOW_MS = 2000;

/** Folds a relayed input message into the per-player input map. */
export const recordInputFrame = (
  inputs: DebugInputs,
  msg: Extract<KapulaServerMessage, { type: "input" }>,
  now: number,
): DebugInputs => {
  const prev = inputs[msg.playerId];
  // The driver contract is highest-seq-wins; drop stale frames.
  if (prev && msg.seq <= prev.seq) return inputs;
  const recentAt = [...(prev?.recentAt ?? []), now].filter(
    (at) => now - at <= RATE_WINDOW_MS,
  );
  return {
    ...inputs,
    [msg.playerId]: {
      seq: msg.seq,
      controls: msg.controls,
      recentAt,
      motion: prev?.motion,
      texts: prev?.texts,
    },
  };
};

/**
 * Folds a relayed motion batch in. Unlike frames there is no seq: a stream
 * is never stale, every sample counts toward the rate.
 */
export const recordMotionBatch = (
  inputs: DebugInputs,
  msg: Extract<KapulaServerMessage, { type: "motion" }>,
  now: number,
): DebugInputs => {
  const prev = inputs[msg.playerId];
  const recentAt = [
    ...(prev?.motion?.recentAt ?? []),
    ...msg.samples.map(() => now),
  ].filter((at) => now - at <= RATE_WINDOW_MS);
  return {
    ...inputs,
    [msg.playerId]: {
      seq: prev?.seq ?? 0,
      controls: prev?.controls ?? {},
      recentAt: prev?.recentAt ?? [],
      motion: { last: msg.samples[msg.samples.length - 1], recentAt },
      texts: prev?.texts,
    },
  };
};

/** Folds a relayed `text` message in: the control's latest text. */
export const recordTextMessage = (
  inputs: DebugInputs,
  msg: Extract<KapulaServerMessage, { type: "text" }>,
): DebugInputs => {
  const prev = inputs[msg.playerId];
  return {
    ...inputs,
    [msg.playerId]: {
      seq: prev?.seq ?? 0,
      controls: prev?.controls ?? {},
      recentAt: prev?.recentAt ?? [],
      motion: prev?.motion,
      texts: { ...prev?.texts, [msg.controlId]: msg.text },
    },
  };
};

const countLastSecond = (recentAt: number[] | undefined, now: number) =>
  (recentAt ?? []).filter((at) => now - at <= 1000).length;

/** Frames received in the last second — verifies the ~30fps client throttle. */
export const inputRateHz = (
  input: DebugPlayerInput | undefined,
  now: number,
): number => countLastSecond(input?.recentAt, now);

/** Motion samples received in the last second — the phone's sensor rate. */
export const motionRateHz = (
  input: DebugPlayerInput | undefined,
  now: number,
): number => countLastSecond(input?.motion?.recentAt, now);

export const MAX_DEBUG_EVENTS = 80;

export type DebugEvent = { at: number; text: string };

export const appendDebugEvent = (
  events: DebugEvent[],
  event: DebugEvent,
): DebugEvent[] => [...events, event].slice(-MAX_DEBUG_EVENTS);

const playerName = (
  snapshot: KapulaSessionSnapshot | null,
  playerId: string,
): string =>
  snapshot?.players.find((p) => p.playerId === playerId)?.name ??
  playerId.slice(0, 8);

/**
 * One-line log text for a server message, or null for messages too chatty to
 * log (input frames and pongs — inputs render live in the player cards).
 */
export const describeServerMessage = (
  msg: KapulaServerMessage,
  snapshot: KapulaSessionSnapshot | null,
): string | null => {
  switch (msg.type) {
    case "input":
    case "motion":
    case "pong":
      return null;
    case "text":
      return `${playerName(snapshot, msg.playerId)} sent ${msg.controlId}: ${JSON.stringify(msg.text)}`;
    case "snapshot":
      return `snapshot: ${msg.snapshot.state}, ${msg.snapshot.players.length} player(s)`;
    case "state_changed":
      return `state → ${msg.state} (${msg.reason})`;
    case "player_joined":
      return `${msg.player.name} joined`;
    case "player_updated":
      return `${msg.player.name}: ready=${msg.player.ready}, schema=${msg.player.schemaId}`;
    case "player_connected":
      return `${playerName(snapshot, msg.playerId)} connected`;
    case "player_disconnected":
      return `${playerName(snapshot, msg.playerId)} disconnected`;
    case "player_left":
      return `${playerName(snapshot, msg.playerId)} left`;
    case "driver_connected":
      return "driver connected";
    case "driver_disconnected":
      return "driver disconnected";
    case "error":
      return `error ${msg.code}: ${msg.message}`;
    default:
      return JSON.stringify(msg);
  }
};
