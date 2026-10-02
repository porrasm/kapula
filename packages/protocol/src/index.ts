import { z } from "zod";

/**
 * Kapula: phones act as controllers for an external "driver" (a game or
 * desktop app). This module is the wire protocol shared by the server, the
 * phone UI, external drivers and the tests.
 *
 * Version 2 is the Kapula wire: version 1 was the "gamepad" app's, and the
 * bump marks the renamed paths (`/api/kapula`), header
 * (`x-kapula-ratelimit-key`) and key prefix (`kpk_`); the messages
 * themselves did not change. It is PRE-RELEASE until the first stable Kapula
 * release — the shape may still change, and every known driver author is
 * told before a breaking change lands. Within a version the rules are
 * additive — new optional fields, new message types, new enum values; never
 * remove, rename or repurpose anything without bumping this constant —
 * because clients ignore what they do not recognize. At the stable release
 * the version freezes for good; from then on anything else is version 3,
 * served next to 2 and negotiated with `protocolVersion` at setup.
 *
 * Drivers receive the version in the setup response and in every snapshot.
 * See docs/KAPULA.md in the repository for the full protocol documentation
 * and docs/BACKLOG.md for the work list.
 */
export const KAPULA_PROTOCOL_VERSION = 2;

/**
 * How long a session survives without its driver. A driver that stays away
 * this long (never connected after setup, or dropped and did not come back)
 * is treated as permanently lost: the session ends for everyone with reason
 * `driver_lost`. Recovery is a *new* session — see `roster` in the session
 * config for the fast path.
 */
export const KAPULA_DRIVER_LOST_TIMEOUT_MS = 3 * 60_000;

export const kapulaSessionStateSchema = z.enum([
  "not_initialized",
  "waiting_for_players",
  "in_progress",
  "paused",
  "ended",
]);
export type KapulaSessionState = z.infer<typeof kapulaSessionStateSchema>;

// --- Player names and colors ---

export const KAPULA_PLAYER_NAME_MAX_LENGTH = 16;

/** Trims and collapses internal whitespace; validation happens after this. */
export const normalizeKapulaPlayerName = (raw: string): string =>
  raw.trim().replace(/\s+/g, " ");

// Unicode letters and digits plus space, dash and underscore — no random
// symbols. Applied after normalization.
const PLAYER_NAME_PATTERN = /^[\p{L}\p{N} _-]+$/u;

export const kapulaPlayerNameSchema = z
  .string()
  .transform(normalizeKapulaPlayerName)
  .pipe(
    z
      .string()
      .min(1, "Name is required")
      .max(KAPULA_PLAYER_NAME_MAX_LENGTH, "Name is too long")
      .regex(PLAYER_NAME_PATTERN, "Only letters, numbers, space, - and _"),
  );

export const kapulaColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Colors must be #RRGGBB hex");

/** Fallback palette when the driver does not provide one (12 = player cap). */
export const KAPULA_DEFAULT_COLORS = [
  "#FF6B6B", // red
  "#4D96FF", // blue
  "#6BCB77", // green
  "#FFD93D", // yellow
  "#B983FF", // purple
  "#FF9F45", // orange
  "#4ECDC4", // teal
  "#F473B9", // pink
  "#A9907E", // brown
  "#98C1D9", // steel
  "#C7F464", // lime
  "#F8F9FA", // white
] as const;

// --- Control schemas (defined by the driver, rendered by the player phone) ---

const idSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Ids are lowercase kebab-case");

/**
 * Layout hints — optional, declarative intent from the driver. The phone owns
 * all geometry (positions, sizes in pixels, orientation handling); hints only
 * steer which thumb zone a control lands in and how much visual weight it
 * gets. Controls without hints fall back to the array-order heuristics, so
 * hints are purely additive and old drivers keep working unchanged.
 *
 * - "left" / "right": the thumb zones — a joystick's corner, or a button
 *   diamond under that thumb (each diamond holds 4; further buttons spill to
 *   that side's shoulder row).
 * - "shoulder-left" / "shoulder-right": pills along the top edge, where index
 *   fingers curl.
 * - "aux": the small top-center row for rarely used controls (pause, menu).
 */
export const kapulaControlZoneSchema = z.enum([
  "left",
  "right",
  "shoulder-left",
  "shoulder-right",
  "aux",
]);
export type KapulaControlZone = z.infer<typeof kapulaControlZoneSchema>;

/** Visual weight relative to the zone's default — never pixels. */
export const kapulaControlSizeSchema = z.enum(["small", "medium", "large"]);
export type KapulaControlSize = z.infer<typeof kapulaControlSizeSchema>;

/**
 * Exact placement — the one hint that is geometry: the control's center as
 * a percentage (0–100) of the controller box's width (`x`, from the left
 * edge) and height (`y`, from the top edge), in the orientation the schema
 * renders in (lock it with `orientation` for a fixed layout). Each axis is
 * optional on its own; an axis left out keeps the engine's placement. The
 * engine still sizes the control (from its zone and `size`) and clamps the
 * box into the viewport, so a position can never hide a control off-screen.
 * Players may still move it unless the config sets
 * `disallowLayoutCustomization`.
 */
export const kapulaControlPositionSchema = z.number().min(0).max(100);

/**
 * A button's outline: "round" (default — a circle under a thumb, a pill on
 * the shoulder / aux rows) or "rect", the same box with squared-off corners.
 * Only the look changes: the engine sizes and places both the same way.
 */
export const kapulaButtonShapeSchema = z.enum(["round", "rect"]);
export type KapulaButtonShape = z.infer<typeof kapulaButtonShapeSchema>;

export const kapulaButtonControlSchema = z.object({
  type: z.literal("button"),
  id: idSchema,
  label: z.string().min(1).max(16),
  zone: kapulaControlZoneSchema.optional(),
  size: kapulaControlSizeSchema.optional(),
  x: kapulaControlPositionSchema.optional(),
  y: kapulaControlPositionSchema.optional(),
  shape: kapulaButtonShapeSchema.optional(),
});

/**
 * What a joystick reports:
 * - "full" (default): both axes, `{x, y}` in [-1, 1]
 * - "relative": both axes like "full", but the stick has no fixed center —
 *   wherever the finger lands becomes the neutral point and the value is the
 *   drag from there (which may continue outside the pad; it ends on release).
 *   Lifting and touching down again therefore always starts from neutral,
 *   which is what precise aiming wants. Rendered as a square pad.
 * - "x" / "y": a single axis, `{x}` / `{y}` — a slider (steering, throttle)
 * - "dpad": 9 discrete directions, sent as a string only when the direction
 *   changes — no intermediate values, so far fewer input frames
 */
export const kapulaJoystickModeSchema = z.enum([
  "full",
  "relative",
  "x",
  "y",
  "dpad",
]);
export type KapulaJoystickMode = z.infer<typeof kapulaJoystickModeSchema>;

export const kapulaJoystickControlSchema = z.object({
  type: z.literal("joystick"),
  id: idSchema,
  label: z.string().min(1).max(16).optional(),
  mode: kapulaJoystickModeSchema.default("full"),
  zone: kapulaControlZoneSchema.optional(),
  size: kapulaControlSizeSchema.optional(),
  x: kapulaControlPositionSchema.optional(),
  y: kapulaControlPositionSchema.optional(),
});

/**
 * What a gyro reports (all axes derived from device tilt only — beta/gamma,
 * i.e. pitch and roll; yaw needs the compass and drifts, so it is
 * deliberately not part of the protocol):
 * - "full" (default): both tilt axes as `{x, y}` in [-1, 1]
 * - "x": roll only (tilt the screen's right edge down = positive) — `{x}`
 * - "y": pitch only (tilt the screen's top edge toward you = positive) — `{y}`
 */
export const kapulaGyroModeSchema = z.enum(["full", "x", "y"]);
export type KapulaGyroMode = z.infer<typeof kapulaGyroModeSchema>;

export const KAPULA_GYRO_RANGE_DEFAULT = 45;

/**
 * A hardware tilt sensor, not an on-screen control: it occupies no space in
 * the controller layout and streams as a virtual joystick in the same input
 * frames. The phone auto-calibrates its neutral pose when the controller
 * appears and offers a recalibrate control. Devices without a usable sensor
 * (or with motion permission denied) cannot select a schema containing one,
 * so drivers offering gyro schemas should always include a gyro-free
 * fallback schema.
 */
export const kapulaGyroControlSchema = z.object({
  type: z.literal("gyro"),
  id: idSchema,
  mode: kapulaGyroModeSchema.default("full"),
  /** Degrees of tilt from the calibrated neutral that count as full deflection. */
  range: z.number().min(5).max(90).default(KAPULA_GYRO_RANGE_DEFAULT),
});

/**
 * The raw inertial sensors, for drivers that do their own motion processing
 * — emulators above all (Dolphin reconstructs a Wii Remote's accelerometer
 * and MotionPlus from exactly this feed). Unlike `gyro`, nothing is
 * calibrated, dead-zoned, clamped or remapped: samples stream in the device
 * frame in a separate `motion` message (see `kapulaMotionSampleSchema`),
 * outside the coalesced input frames, at the sensor rate (~60 Hz on phones).
 * Like `gyro` it occupies no layout space and needs a usable sensor, so a
 * motion-free fallback schema is the recommended companion.
 */
export const kapulaMotionControlSchema = z.object({
  type: z.literal("motion"),
  id: idSchema,
});

/** Most fingers a `raw` control reports at once (a two-handed full grab). */
export const KAPULA_RAW_MAX_TOUCHES = 10;

/**
 * The whole controller box as one touch surface: every finger on the
 * background and where it is (see `kapulaRawTouchSchema`). For drivers that
 * interpret touch themselves — gestures, a mirrored game screen the player
 * taps on. It lies under the schema's other controls: a finger that lands on
 * a button, stick or touchpad belongs to that control for as long as it is
 * down and is never reported here; every other finger is. At most one per
 * schema. Pairs naturally with a driver-posted background image, which fills
 * the same box the coordinates are measured in.
 */
export const kapulaRawControlSchema = z.object({
  type: z.literal("raw"),
  id: idSchema,
});

export const KAPULA_TOUCHPAD_ASPECT_MIN = 0.25;
export const KAPULA_TOUCHPAD_ASPECT_MAX = 4;

/**
 * A laid-out multitouch pad — the `raw` surface as one control among others
 * (a laptop touchpad next to mouse buttons and a scroll slider). It reports
 * exactly what `raw` does, `[{id, x, y}, …]`, with positions 0–1 inside the
 * pad itself; the phone computes nothing from them (no deltas, taps or
 * gestures — that is the driver's job). `aspect` is the pad's width / height
 * (default 1, a square); the engine sizes it like a stick and a player's
 * resize scales it uniformly, so the aspect the driver declared is always
 * the pad's real one and the driver can turn 0–1 positions into isotropic
 * motion.
 */
export const kapulaTouchpadControlSchema = z.object({
  type: z.literal("touchpad"),
  id: idSchema,
  label: z.string().min(1).max(16).optional(),
  aspect: z
    .number()
    .min(KAPULA_TOUCHPAD_ASPECT_MIN)
    .max(KAPULA_TOUCHPAD_ASPECT_MAX)
    .optional(),
  zone: kapulaControlZoneSchema.optional(),
  size: kapulaControlSizeSchema.optional(),
  x: kapulaControlPositionSchema.optional(),
  y: kapulaControlPositionSchema.optional(),
});

/** Longest text a `text` control sends (and its `maxLength` ceiling). */
export const KAPULA_TEXT_MAX_LENGTH = 1000;

/**
 * A text answer typed on the player's own keyboard — the phone's on-screen
 * keyboard, or a real one on a laptop. On the controller it is a button
 * (placed and hinted exactly like one); tapping it opens a text field with
 * the keyboard, and "Send" (or Enter) delivers the whole text as one `text`
 * message to the driver — never as input-frame state, since typed text is
 * an event that must not be coalesced away. What was typed is not echoed to
 * the driver keystroke by keystroke: submit only. The field clears after
 * sending. `maxLength` caps it on the phone (default and ceiling
 * `KAPULA_TEXT_MAX_LENGTH`).
 */
export const kapulaTextControlSchema = z.object({
  type: z.literal("text"),
  id: idSchema,
  label: z.string().min(1).max(16).optional(),
  maxLength: z.number().int().min(1).max(KAPULA_TEXT_MAX_LENGTH).optional(),
  zone: kapulaControlZoneSchema.optional(),
  size: kapulaControlSizeSchema.optional(),
  x: kapulaControlPositionSchema.optional(),
  y: kapulaControlPositionSchema.optional(),
  shape: kapulaButtonShapeSchema.optional(),
});

export const kapulaControlSchema = z.discriminatedUnion("type", [
  kapulaButtonControlSchema,
  kapulaJoystickControlSchema,
  kapulaGyroControlSchema,
  kapulaMotionControlSchema,
  kapulaRawControlSchema,
  kapulaTouchpadControlSchema,
  kapulaTextControlSchema,
]);
export type KapulaControl = z.infer<typeof kapulaControlSchema>;
export type KapulaTouchpadControl = z.infer<typeof kapulaTouchpadControlSchema>;
export type KapulaTextControl = z.infer<typeof kapulaTextControlSchema>;
export type KapulaGyroControl = z.infer<typeof kapulaGyroControlSchema>;
export type KapulaMotionControl = z.infer<typeof kapulaMotionControlSchema>;
export type KapulaRawControl = z.infer<typeof kapulaRawControlSchema>;

/**
 * Per-schema orientation hint. "auto" (default) lets the phone decide from
 * the control count; "landscape" always demands two-handed landscape;
 * "portrait" declares a one-handed portrait controller. The phone owns the
 * orientation: it renders the controller the demanded way whatever the
 * device's own rotation does (rotating the content itself when the OS will
 * not), so a player can lock rotation on their phone and still play.
 */
export const kapulaOrientationSchema = z.enum([
  "auto",
  "landscape",
  "portrait",
]);
export type KapulaOrientation = z.infer<typeof kapulaOrientationSchema>;

export const controlSchemaSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(32),
    orientation: kapulaOrientationSchema.default("auto"),
    controls: z.array(kapulaControlSchema).min(1).max(16),
  })
  .superRefine((schema, ctx) => {
    const ids = new Set<string>();
    for (const control of schema.controls) {
      if (ids.has(control.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate control id "${control.id}"`,
          path: ["controls"],
        });
      }
      ids.add(control.id);
    }
    // A phone has one tilt sensor; two gyro controls would stream identical
    // values under different ids. Same for the raw motion stream.
    if (schema.controls.filter((c) => c.type === "gyro").length > 1) {
      ctx.addIssue({
        code: "custom",
        message: "A schema can have at most one gyro control",
        path: ["controls"],
      });
    }
    if (schema.controls.filter((c) => c.type === "motion").length > 1) {
      ctx.addIssue({
        code: "custom",
        message: "A schema can have at most one motion control",
        path: ["controls"],
      });
    }
    // A raw control is the whole background: a second one would report the
    // same fingers twice. (Other controls sit on top of it and keep their
    // own fingers.)
    if (schema.controls.filter((c) => c.type === "raw").length > 1) {
      ctx.addIssue({
        code: "custom",
        message: "A schema can have at most one raw control",
        path: ["controls"],
      });
    }
  });
export type ControlSchema = z.infer<typeof controlSchemaSchema>;

/**
 * Whether selecting this schema requires working motion sensors — a tilt
 * (`gyro`) control or a raw `motion` stream. Both read the same hardware
 * behind the same permission gate.
 */
export const schemaNeedsMotionSensors = (schema: ControlSchema): boolean =>
  schema.controls.some((c) => c.type === "gyro" || c.type === "motion");

/** The schema's `raw` background touch surface, if it has one. */
export const getRawControl = (
  schema: ControlSchema,
): KapulaRawControl | undefined =>
  schema.controls.find((c): c is KapulaRawControl => c.type === "raw");

/** Used when the driver sets up a session without custom schemas. */
export const GENERIC_GAMEPAD_SCHEMA: ControlSchema = {
  id: "generic",
  name: "Gamepad",
  orientation: "auto",
  controls: [
    { type: "joystick", id: "stick", mode: "full" },
    { type: "button", id: "a", label: "A" },
    { type: "button", id: "b", label: "B" },
  ],
};

// --- Driver keys ---

/** Most emails that may be linked to one driver key. */
export const KAPULA_DRIVER_KEY_MAX_LINKED_EMAILS = 20;

/**
 * The emails linked to a driver key (who, besides the owner, may join the
 * key's private sessions): trimmed, lowercased — logins are matched on the
 * lowercased address — and deduplicated.
 */
export const kapulaLinkedEmailsSchema = z
  .array(z.string().trim().toLowerCase().pipe(z.email().max(254)))
  .max(KAPULA_DRIVER_KEY_MAX_LINKED_EMAILS)
  .transform((emails) => [...new Set(emails)]);

// --- Physical gamepads (a real controller paired with the phone) ---

/**
 * The reserved schema id a player selects to play with a real controller
 * (USB or Bluetooth) paired with the phone, instead of the touch layouts.
 * Offered only when the driver set `allowPhysicalGamepad`; a driver's own
 * schemas may not use this id.
 */
export const PHYSICAL_GAMEPAD_SCHEMA_ID = "physical-gamepad";
export const PHYSICAL_GAMEPAD_SCHEMA_NAME = "Real gamepad";

export type PhysicalGamepadControlKind = "button" | "stick" | "dpad" | "trigger";

/**
 * What a physical gamepad reports, as a fixed control set the driver can
 * count on: the W3C Gamepad API's "standard" mapping, with the same value
 * shapes as touch controls. The phone maps every controller onto this set
 * (a controller without the standard mapping is read by the same indices,
 * best effort) and sends it in ordinary `input` frames under
 * `PHYSICAL_GAMEPAD_SCHEMA_ID`.
 *
 * - sticks: `{x, y}` in [-1, 1], y positive downwards, like a "full" joystick
 * - dpad: one of the 9 direction codes, like a "dpad" joystick
 * - buttons: booleans
 * - triggers: a number in [0, 1] (0 = released, 1 = fully pulled), the one
 *   value shape touch controls never send
 *
 * `buttonIndex` / `axisIndices` are the Gamepad API indices, listed for
 * driver authors and the phone alike.
 */
export const PHYSICAL_GAMEPAD_CONTROLS: readonly {
  id: string;
  kind: PhysicalGamepadControlKind;
  label: string;
  buttonIndex?: number;
  axisIndices?: readonly [number, number];
}[] = [
  { id: "left-stick", kind: "stick", label: "Left stick", axisIndices: [0, 1] },
  { id: "right-stick", kind: "stick", label: "Right stick", axisIndices: [2, 3] },
  { id: "dpad", kind: "dpad", label: "D-pad" },
  { id: "a", kind: "button", label: "A", buttonIndex: 0 },
  { id: "b", kind: "button", label: "B", buttonIndex: 1 },
  { id: "x", kind: "button", label: "X", buttonIndex: 2 },
  { id: "y", kind: "button", label: "Y", buttonIndex: 3 },
  { id: "lb", kind: "button", label: "LB", buttonIndex: 4 },
  { id: "rb", kind: "button", label: "RB", buttonIndex: 5 },
  { id: "lt", kind: "trigger", label: "LT", buttonIndex: 6 },
  { id: "rt", kind: "trigger", label: "RT", buttonIndex: 7 },
  { id: "back", kind: "button", label: "Back", buttonIndex: 8 },
  { id: "start", kind: "button", label: "Start", buttonIndex: 9 },
  { id: "ls", kind: "button", label: "L3", buttonIndex: 10 },
  { id: "rs", kind: "button", label: "R3", buttonIndex: 11 },
  { id: "home", kind: "button", label: "Home", buttonIndex: 16 },
];

/** Standard-mapping button indices the phone folds into the `dpad` code. */
export const PHYSICAL_GAMEPAD_DPAD_BUTTONS = {
  up: 12,
  down: 13,
  left: 14,
  right: 15,
} as const;

// --- Session metadata (provided by the host at creation) ---

/**
 * Free-form text the host attaches when creating a session, handed to the
 * driver verbatim in the setup response. Typical use: a launcher app passes
 * game configuration to the game through it. Capped so the field cannot be
 * used to flood the database.
 */
export const KAPULA_METADATA_MAX_LENGTH = 4096;

export const kapulaSessionMetadataSchema = z
  .string()
  .max(KAPULA_METADATA_MAX_LENGTH, "Metadata is too long");

// --- Session config (posted by the driver at setup) ---

export const KAPULA_MAX_PLAYERS_LIMIT = 12;
/** Hard cap on control schemas per session — generous, but bounds payload size. */
export const KAPULA_MAX_SCHEMAS = 32;

/**
 * A predefined player slot. A driver that already knows who is playing (it
 * ran a session before and stored the names and colors) hands the list back
 * at setup instead of letting players pick names; joining players then only
 * choose which slot is theirs.
 */
export const kapulaRosterEntrySchema = z.object({
  name: kapulaPlayerNameSchema,
  color: kapulaColorSchema,
});
export type KapulaRosterEntry = z.infer<typeof kapulaRosterEntrySchema>;

/**
 * A stable identity for the driver application, used by the player phone as
 * the localStorage namespace for the layouts players customize (per schema
 * id). Any driver can send one: generate a UUID once and ship it with the
 * game — the same value on every setup call — and each player's edited
 * layouts come back in every later session of that game. Without it edits
 * last only until the controller is closed.
 */
export const kapulaDriverAppUuidSchema = z.string().uuid();

const kapulaSessionConfigInputSchema = z.object({
  /** Display name of the game, shown to players. */
  game: z.string().min(1).max(64).optional(),
  /** Persistent per-game identity; see `kapulaDriverAppUuidSchema`. */
  driverAppUuid: kapulaDriverAppUuidSchema.optional(),
  /**
   * Lets players pick "Real gamepad" instead of a touch layout: a controller
   * paired with the phone (USB or Bluetooth) is read through the Gamepad
   * API and its state arrives in ordinary input frames under the reserved
   * `PHYSICAL_GAMEPAD_SCHEMA_ID` with the fixed `PHYSICAL_GAMEPAD_CONTROLS`
   * set. Default false — a driver must be ready for those control ids.
   */
  allowPhysicalGamepad: z.boolean().default(false),
  /**
   * Keeps the controller exactly as the driver described it: the phone
   * offers no layout editor (no "Edit layout" / "Reset layout", no
   * full/relative stick swap) and applies no layout a player edited in an
   * earlier session of the game. For games whose controls must sit where
   * the driver put them (see the `x` / `y` control positions). Default
   * false — players own their layout.
   */
  disallowLayoutCustomization: z.boolean().default(false),
  /** Default 1; derived from the roster when one is given. */
  minPlayers: z.number().int().min(1).max(KAPULA_MAX_PLAYERS_LIMIT).optional(),
  /** Default 8; derived from the roster when one is given. */
  maxPlayers: z.number().int().min(1).max(KAPULA_MAX_PLAYERS_LIMIT).optional(),
  schemas: z
    .array(controlSchemaSchema)
    .min(1)
    .max(KAPULA_MAX_SCHEMAS)
    .default(() => [GENERIC_GAMEPAD_SCHEMA]),
  /**
   * Colors players pick from; defaults to KAPULA_DEFAULT_COLORS. Colors are
   * unique per player, so the list must cover maxPlayers.
   */
  colors: z.array(kapulaColorSchema).max(24).optional(),
  /**
   * Lets players join a game that is already running (`in_progress` or
   * `paused`) instead of only in the lobby. Default false — a game that
   * cannot cope with a player appearing mid-match must not be handed one.
   * A late joiner lands straight on the controller; `ready` is meaningless
   * to them. Ignored in roster sessions, where the roster fixes the player
   * set and a slot can only be re-claimed, never added.
   */
  allowLateJoin: z.boolean().default(false),
  /**
   * For sessions that have no rounds — a remote control, a jukebox, a
   * drop-in toy: the driver may `start` without anyone joined or ready
   * (`minPlayers` and ready flags are ignored), and players may join while
   * the game runs, landing straight on the controller (it implies
   * `allowLateJoin`). The server does not start the session itself: the
   * driver sends `start` as soon as it connects, and phones never see a
   * lobby. `lobby` still works and brings one back. Not combinable with a
   * roster, whose whole point is a complete, ready player set. Default false.
   */
  skipLobby: z.boolean().default(false),
  /**
   * A session only certain logged-in users may join: the session's owner,
   * plus — for a session a driver key opened — the emails linked to that key
   * in the host page. It cannot be joined with the join code (the code does
   * not even reveal that it exists); those users find it in the "Your
   * private sessions" list on the app's landing page and join with one tap.
   * The setup response's `joinUrl` therefore points at that landing page.
   * For a remote-controlled PC, with `skipLobby`. Default false.
   */
  private: z.boolean().default(false),
  /**
   * Predefined player slots (the fast path for recreating a lost session).
   * With a roster, joining means picking a free slot: names and colors are
   * fixed, `minPlayers` and `maxPlayers` both equal the roster size, and the
   * game can start only once every slot is filled, connected and ready.
   */
  roster: z
    .array(kapulaRosterEntrySchema)
    .min(1)
    .max(KAPULA_MAX_PLAYERS_LIMIT)
    .optional(),
  /**
   * Opt-in behaviour the driver declares it supports, as free-form strings.
   * The server stores the list verbatim and never interprets it; the phone
   * reads it from the snapshot's config and ignores what it does not know, so
   * a driver may declare a capability an older server or phone has never
   * heard of. Reserved values are documented as they appear.
   */
  capabilities: z.array(z.string().min(1).max(32)).max(16).default([]),
});

export const kapulaSessionConfigSchema = kapulaSessionConfigInputSchema
  .transform((config, ctx) => {
    if (!config.roster) {
      return {
        ...config,
        minPlayers: config.minPlayers ?? 1,
        maxPlayers: config.maxPlayers ?? 8,
      };
    }
    const size = config.roster.length;
    if (config.skipLobby) {
      ctx.addIssue({
        code: "custom",
        message: "skipLobby cannot be combined with a roster",
        path: ["skipLobby"],
      });
    }
    for (const key of ["minPlayers", "maxPlayers"] as const) {
      const given = config[key];
      if (given !== undefined && given !== size) {
        ctx.addIssue({
          code: "custom",
          message: `${key} must equal the roster size (${size}) or be omitted`,
          path: [key],
        });
      }
    }
    return { ...config, minPlayers: size, maxPlayers: size };
  })
  .superRefine((config, ctx) => {
    if (config.minPlayers > config.maxPlayers) {
      ctx.addIssue({
        code: "custom",
        message: "minPlayers cannot exceed maxPlayers",
        path: ["minPlayers"],
      });
    }
    const schemaIds = new Set<string>();
    for (const schema of config.schemas) {
      if (schema.id === PHYSICAL_GAMEPAD_SCHEMA_ID) {
        ctx.addIssue({
          code: "custom",
          message: `Schema id "${PHYSICAL_GAMEPAD_SCHEMA_ID}" is reserved for real gamepads`,
          path: ["schemas"],
        });
      }
      if (schemaIds.has(schema.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate schema id "${schema.id}"`,
          path: ["schemas"],
        });
      }
      schemaIds.add(schema.id);
    }
    if (config.colors) {
      if (new Set(config.colors).size !== config.colors.length) {
        ctx.addIssue({
          code: "custom",
          message: "Colors must be unique",
          path: ["colors"],
        });
      }
      if (config.colors.length < config.maxPlayers) {
        ctx.addIssue({
          code: "custom",
          message: "Provide at least maxPlayers colors",
          path: ["colors"],
        });
      }
    }
    if (config.roster) {
      const palette: readonly string[] = config.colors ?? KAPULA_DEFAULT_COLORS;
      const names = new Set<string>();
      const colors = new Set<string>();
      for (const entry of config.roster) {
        const nameKey = entry.name.toLowerCase();
        if (names.has(nameKey)) {
          ctx.addIssue({
            code: "custom",
            message: `Duplicate roster name "${entry.name}"`,
            path: ["roster"],
          });
        }
        names.add(nameKey);
        if (colors.has(entry.color)) {
          ctx.addIssue({
            code: "custom",
            message: `Duplicate roster color "${entry.color}"`,
            path: ["roster"],
          });
        }
        colors.add(entry.color);
        if (!palette.includes(entry.color)) {
          ctx.addIssue({
            code: "custom",
            message: `Roster color "${entry.color}" is not in the palette`,
            path: ["roster"],
          });
        }
      }
    }
  });
export type KapulaSessionConfig = z.infer<typeof kapulaSessionConfigSchema>;

export const getSessionColors = (
  config: KapulaSessionConfig,
): readonly string[] => config.colors ?? KAPULA_DEFAULT_COLORS;

/**
 * Whether a player may select this schema id: one of the driver's schemas,
 * or the reserved physical-gamepad id when the driver allowed it. Used by
 * the server to gate `select_schema` and by the phone to render the picker.
 */
export const isSelectableSchemaId = (
  config: Pick<KapulaSessionConfig, "schemas" | "allowPhysicalGamepad">,
  schemaId: string,
): boolean =>
  config.schemas.some((schema) => schema.id === schemaId) ||
  (config.allowPhysicalGamepad && schemaId === PHYSICAL_GAMEPAD_SCHEMA_ID);

/**
 * Whether the driver declared a capability (see `capabilities` in the session
 * config). Unknown names are simply false, so both sides can ask about a
 * capability the other has never heard of.
 */
export const hasCapability = (
  config: Pick<KapulaSessionConfig, "capabilities">,
  name: string,
): boolean => config.capabilities.includes(name);

/** Whether the player has more than one way to control the game to pick from. */
export const hasSchemaChoice = (
  config: Pick<KapulaSessionConfig, "schemas" | "allowPhysicalGamepad">,
): boolean => config.schemas.length > 1 || config.allowPhysicalGamepad;

// --- Runtime session info ---

// --- Background image (posted by the driver over HTTP) ---

/** Largest background image a driver may post, in bytes. */
export const KAPULA_BACKGROUND_MAX_BYTES = 2 * 1024 * 1024;

/**
 * How the image fills the controller box: "cover" (default) fills it and
 * crops the overflow, "contain" shows all of it (letterboxed), "fill"
 * stretches it to the box exactly — the one where image pixels line up with
 * `raw` touch coordinates whatever the phone's aspect ratio.
 */
export const kapulaBackgroundFitSchema = z.enum(["cover", "contain", "fill"]);
export type KapulaBackgroundFit = z.infer<typeof kapulaBackgroundFitSchema>;

/**
 * The image the driver posted, as the phone shows it behind the controller.
 * `url` is a same-origin path that changes with every upload, so it can be
 * cached forever.
 */
export const kapulaBackgroundSchema = z.object({
  url: z.string(),
  fit: kapulaBackgroundFitSchema,
});
export type KapulaBackground = z.infer<typeof kapulaBackgroundSchema>;

export const kapulaPlayerInfoSchema = z.object({
  playerId: z.string(),
  name: z.string(),
  color: kapulaColorSchema,
  ready: z.boolean(),
  connected: z.boolean(),
  schemaId: z.string(),
});
export type KapulaPlayerInfo = z.infer<typeof kapulaPlayerInfoSchema>;

export const kapulaSessionSnapshotSchema = z.object({
  /**
   * The protocol version this server speaks, so a driver that reconnects
   * without the setup response it once got still knows what it is talking to.
   */
  protocolVersion: z.number().int(),
  sessionId: z.string(),
  state: kapulaSessionStateSchema,
  config: kapulaSessionConfigSchema,
  driverConnected: z.boolean(),
  players: z.array(kapulaPlayerInfoSchema),
  /** The driver's background image; absent until one is posted. */
  background: kapulaBackgroundSchema.optional(),
});
export type KapulaSessionSnapshot = z.infer<
  typeof kapulaSessionSnapshotSchema
>;

// --- Input ---

const axisSchema = z.number().finite().min(-1).max(1);

/**
 * The 9 states of a "dpad" joystick, as compact wire codes — dpad values ride
 * in every full-state input frame, so they stay 1–2 chars: "c" is the
 * released center; "u"/"r"/"d"/"l" are up/right/down/left (screen directions,
 * y down); diagonals concatenate them ("ur" = up-right, …).
 */
export const KAPULA_DPAD_DIRECTIONS = [
  "c",
  "u",
  "ur",
  "r",
  "dr",
  "d",
  "dl",
  "l",
  "ul",
] as const;
export const kapulaDpadDirectionSchema = z.enum(KAPULA_DPAD_DIRECTIONS);
export type KapulaDpadDirection = z.infer<typeof kapulaDpadDirectionSchema>;

const DIAGONAL = Math.SQRT1_2;

/**
 * Driver convenience: a dpad direction as a unit vector in joystick
 * coordinates (y positive downwards, diagonals normalized to length 1).
 */
export const dpadToVector = (
  direction: KapulaDpadDirection,
): { x: number; y: number } => {
  switch (direction) {
    case "u":
      return { x: 0, y: -1 };
    case "ur":
      return { x: DIAGONAL, y: -DIAGONAL };
    case "r":
      return { x: 1, y: 0 };
    case "dr":
      return { x: DIAGONAL, y: DIAGONAL };
    case "d":
      return { x: 0, y: 1 };
    case "dl":
      return { x: -DIAGONAL, y: DIAGONAL };
    case "l":
      return { x: -1, y: 0 };
    case "ul":
      return { x: -DIAGONAL, y: -DIAGONAL };
    case "c":
      return { x: 0, y: 0 };
  }
};

/**
 * One finger on a `raw` or `touchpad` control. `id` is the finger's slot,
 * stable from touch-down to lift-off: the lowest number not held by another
 * finger of the same control, so ids are small and get reused. `x` / `y` are
 * the finger's position in the control's box (the whole controller box for
 * `raw`, the pad for `touchpad`), 0–1 from its left / top edge (y down, like
 * the sticks), rounded to 3 decimals. A finger dragged past the edge is
 * clamped to it and keeps reporting until it lifts.
 */
export const kapulaRawTouchSchema = z.object({
  id: z.number().int().min(0).max(KAPULA_RAW_MAX_TOUCHES - 1),
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
});
export type KapulaRawTouch = z.infer<typeof kapulaRawTouchSchema>;

/**
 * Buttons are booleans; joysticks report by mode — full: `{x, y}`,
 * single-axis: `{x}` / `{y}` (all axes normalized to [-1, 1]), dpad: a
 * direction string. A bare number is an analog scalar in [-1, 1] — today
 * only a physical gamepad's triggers send one (0 = released, 1 = pulled).
 * An array is a `raw` or `touchpad` control's fingers (empty when nothing
 * touches).
 */
export const kapulaInputValueSchema = z.union([
  z.boolean(),
  z.object({ x: axisSchema, y: axisSchema }),
  // Strict, so a full frame with one bad axis can't sneak through as a
  // single-axis value with the other axis stripped.
  z.strictObject({ x: axisSchema }),
  z.strictObject({ y: axisSchema }),
  kapulaDpadDirectionSchema,
  axisSchema,
  z.array(kapulaRawTouchSchema).max(KAPULA_RAW_MAX_TOUCHES),
]);
export type KapulaInputValue = z.infer<typeof kapulaInputValueSchema>;

/**
 * Full controller state, sent whenever it changes (throttled; button edges
 * flush immediately). The driver keeps only the highest seq per player.
 *
 * `seq` is a per-player strictly increasing integer for the lifetime of the
 * player, across reconnects and schema switches. It is owned by the phone
 * (seeded from wall-clock milliseconds at page load, +1 per frame); the
 * server relays it as is and drops non-increasing frames. Expect gaps.
 */
export const kapulaInputFrameSchema = z.object({
  seq: z.number().int().nonnegative(),
  controls: z.record(idSchema, kapulaInputValueSchema),
});
export type KapulaInputFrame = z.infer<typeof kapulaInputFrameSchema>;

// --- Motion stream (schemas with a `motion` control) ---

/** Largest accelerations / angular rates a phone IMU reports; beyond is garbage. */
export const KAPULA_MOTION_ACCEL_MAX_G = 32;
export const KAPULA_MOTION_RATE_MAX_DPS = 8000;

/** Samples per `motion` message; the phone batches a few sensor events. */
export const KAPULA_MOTION_BATCH_MAX = 16;

const accelSchema = z
  .number()
  .finite()
  .min(-KAPULA_MOTION_ACCEL_MAX_G)
  .max(KAPULA_MOTION_ACCEL_MAX_G);
const rateSchema = z
  .number()
  .finite()
  .min(-KAPULA_MOTION_RATE_MAX_DPS)
  .max(KAPULA_MOTION_RATE_MAX_DPS);

/**
 * One raw IMU reading, as a compact tuple `[t, ax, ay, az, gx, gy, gz]`:
 * - `t`: the phone's monotonic sample time in ms (arbitrary origin, so use
 *   differences only — it is what lets a driver integrate rates correctly
 *   when messages arrive in bursts).
 * - `ax, ay, az`: acceleration **including gravity**, in g, as the reaction
 *   force: a phone lying flat and still reads `[0, 0, +1]`. The phone
 *   normalizes browser sign quirks so every platform reports this way.
 * - `gx, gy, gz`: angular rate about the same axes, in degrees/second,
 *   right-hand rule (positive gz = the phone turning counter-clockwise seen
 *   from above its screen).
 *
 * Axes are the device frame of the W3C DeviceOrientation spec, never the
 * screen's: x points to the right of the screen in its natural (portrait)
 * orientation, y toward the top edge, z out of the screen toward the
 * player. How the player holds the phone is the driver's convention to
 * declare — the Wii Remote hold is portrait, top edge toward the TV, screen
 * up, so the remote's forward is +y, its up is +z, its right is +x.
 */
export const kapulaMotionSampleSchema = z.tuple([
  z.number().finite().nonnegative(),
  accelSchema,
  accelSchema,
  accelSchema,
  rateSchema,
  rateSchema,
  rateSchema,
]);
export type KapulaMotionSample = z.infer<typeof kapulaMotionSampleSchema>;

const motionSamplesSchema = z
  .array(kapulaMotionSampleSchema)
  .min(1)
  .max(KAPULA_MOTION_BATCH_MAX);

// --- WebSocket messages: client → server ---

export const kapulaPlayerClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("set_ready"), ready: z.boolean() }),
  z.object({ type: z.literal("select_schema"), schemaId: idSchema }),
  /** Lobby-only: change the auto-assigned name and/or color. */
  z.object({
    type: z.literal("update_profile"),
    name: kapulaPlayerNameSchema.optional(),
    color: kapulaColorSchema.optional(),
  }),
  /**
   * Full controller state. `seq` is phone-owned and strictly increasing for
   * the player's lifetime (see kapulaInputFrameSchema); the server drops a
   * frame whose seq does not exceed the last one it relayed for the player.
   */
  z.object({
    type: z.literal("input"),
    seq: z.number().int().nonnegative(),
    controls: z.record(idSchema, kapulaInputValueSchema),
  }),
  /**
   * Raw IMU samples from a schema's `motion` control, oldest first. A stream,
   * not state: every sample matters, nothing is deduplicated or latest-wins.
   * Relayed while in_progress only, like input.
   */
  z.object({ type: z.literal("motion"), samples: motionSamplesSchema }),
  /**
   * Text the player sent from a `text` control. An event, not state: no
   * seq, nothing latest-wins — every message is relayed, in order. Relayed
   * while in_progress only, like input.
   */
  z.object({
    type: z.literal("text"),
    controlId: idSchema,
    text: z.string().max(KAPULA_TEXT_MAX_LENGTH),
  }),
  /**
   * Leave the session for good: frees the name/color slot, invalidates the
   * player token and announces player_left. Allowed in any state — a stuck or
   * paused session must never trap a player.
   */
  z.object({ type: z.literal("leave") }),
]);
export type KapulaPlayerClientMessage = z.infer<
  typeof kapulaPlayerClientMessageSchema
>;

export const kapulaDriverClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("start") }),
  z.object({ type: z.literal("pause") }),
  z.object({ type: z.literal("resume") }),
  z.object({ type: z.literal("end") }),
  /**
   * Remove a player for good: the slot (name and color) is freed and their
   * token dies, exactly as if they had sent `leave`. Their socket closes with
   * 4011. Not a ban — nothing stops them joining again with the join code.
   */
  z.object({ type: z.literal("kick"), playerId: z.string() }),
  /**
   * Back to the lobby from `in_progress` or `paused` — between rounds, so
   * players can change their layout, name or color and ready up again. Every
   * player's `ready` is cleared, so the next `start` waits for a fresh
   * ready-up. New players can join again too, as in any lobby.
   */
  z.object({ type: z.literal("lobby") }),
  /**
   * Small payload delivered to one player (or all when playerId is omitted).
   * The payload may be absent (explicitly optional: since zod 4.6 a bare
   * `z.unknown()` key is required at runtime, which silently broke this
   * frozen-protocol message when the dependency was bumped).
   */
  z.object({
    type: z.literal("message"),
    playerId: z.string().optional(),
    payload: z.unknown().optional(),
  }),
  /**
   * Put a player on a control schema (all players when playerId is omitted) —
   * for games whose controls change by phase: menu, driving, on foot. Allowed
   * in any live state, like the player's own `select_schema`; the phone
   * follows the id it sees in `player_updated`. The player may still switch
   * from the in-game menu afterwards.
   */
  z.object({
    type: z.literal("set_schema"),
    playerId: z.string().optional(),
    schemaId: z.string(),
  }),
]);
export type KapulaDriverClientMessage = z.infer<
  typeof kapulaDriverClientMessageSchema
>;

// --- WebSocket messages: server → client ---

export const kapulaStateChangeReasonSchema = z.enum([
  "driver_command",
  "driver_disconnected",
  /** The driver stayed away for KAPULA_DRIVER_LOST_TIMEOUT_MS; session ended. */
  "driver_lost",
  "host_ended",
  "inactivity",
]);
export type KapulaStateChangeReason = z.infer<
  typeof kapulaStateChangeReasonSchema
>;

/**
 * Codes on the `error` server message — a closed set a driver can switch on.
 *
 * New codes may be added in a later protocol revision (adding one is an
 * additive change under the version 1 policy), so treat an unknown code as a
 * generic error and show `message` rather than failing.
 */
export const kapulaErrorCodeSchema = z.enum([
  /** The action is not allowed in the session's current state. */
  "invalid_state",
  /** `start` refused: not everyone is joined, connected and ready. */
  "cannot_start",
  /** The requested name or color is already another player's. */
  "profile_taken",
  /** Roster session: names and colors come from the roster and are fixed. */
  "profile_locked",
  /** No schema with that id in the session config. */
  "unknown_schema",
  /** No such player in this session (driver-addressed messages). */
  "unknown_player",
]);
export type KapulaErrorCode = z.infer<typeof kapulaErrorCodeSchema>;

export const kapulaServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pong") }),
  /** First message after connecting; `playerId` set for the player role. */
  z.object({
    type: z.literal("snapshot"),
    snapshot: kapulaSessionSnapshotSchema,
    playerId: z.string().optional(),
  }),
  /** Every state change states why; see kapulaStateChangeReasonSchema. */
  z.object({
    type: z.literal("state_changed"),
    state: kapulaSessionStateSchema,
    reason: kapulaStateChangeReasonSchema,
  }),
  z.object({ type: z.literal("player_joined"), player: kapulaPlayerInfoSchema }),
  z.object({ type: z.literal("player_updated"), player: kapulaPlayerInfoSchema }),
  z.object({ type: z.literal("player_connected"), playerId: z.string() }),
  z.object({ type: z.literal("player_disconnected"), playerId: z.string() }),
  /** The player left for good; the slot (name + color) is free again. */
  z.object({ type: z.literal("player_left"), playerId: z.string() }),
  z.object({ type: z.literal("driver_connected") }),
  z.object({ type: z.literal("driver_disconnected") }),
  /**
   * Driver only: relayed player input. `seq` is the phone's, relayed as is:
   * strictly increasing per player for the player's lifetime, across
   * reconnects and schema switches. Keep only the highest seq per player.
   */
  z.object({
    type: z.literal("input"),
    playerId: z.string(),
    seq: z.number().int().nonnegative(),
    controls: z.record(idSchema, kapulaInputValueSchema),
  }),
  /** Driver only: relayed raw IMU samples (schemas with a `motion` control). */
  z.object({
    type: z.literal("motion"),
    playerId: z.string(),
    samples: motionSamplesSchema,
  }),
  /** Driver only: text a player sent from a `text` control, in order. */
  z.object({
    type: z.literal("text"),
    playerId: z.string(),
    controlId: idSchema,
    text: z.string().max(KAPULA_TEXT_MAX_LENGTH),
  }),
  /** Player only: payload from the driver; absent when the driver sent none. */
  z.object({ type: z.literal("message"), payload: z.unknown().optional() }),
  /**
   * Player only: the driver posted (or, with null, removed) its background
   * image. The snapshot carries the current one on (re)connect.
   */
  z.object({
    type: z.literal("background_changed"),
    background: kapulaBackgroundSchema.nullable(),
  }),
  /**
   * The last action was refused. `code` is for branching, `message` is
   * human-readable; unknown codes must be treated as generic errors.
   */
  z.object({
    type: z.literal("error"),
    code: kapulaErrorCodeSchema,
    message: z.string(),
  }),
]);
export type KapulaServerMessage = z.infer<typeof kapulaServerMessageSchema>;

// --- Driver HTTP API ---

/** Human-typeable codes: no 0/O/1/I/L lookalikes. */
export const KAPULA_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const KAPULA_CODE_LENGTH = 6;

export const kapulaCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(
    z
      .string()
      .length(KAPULA_CODE_LENGTH)
      .regex(new RegExp(`^[${KAPULA_CODE_ALPHABET}]+$`), "Invalid code"),
  );

export const kapulaDriverSetupRequestSchema = z.object({
  setupCode: kapulaCodeSchema,
  /** Omitted config sets up a single generic gamepad schema. */
  config: kapulaSessionConfigSchema.default(() =>
    kapulaSessionConfigSchema.parse({}),
  ),
  /**
   * The protocol version the driver wants to speak. Omitted means "whatever
   * this server serves" (the answer comes back in the response). A version
   * the server does not serve is refused with 400 and the list of the ones it
   * does, so a driver pinned to an old version fails loudly at setup instead
   * of misreading frames later.
   */
  protocolVersion: z.number().int().positive().optional(),
});
export type KapulaDriverSetupRequest = z.infer<
  typeof kapulaDriverSetupRequestSchema
>;

/**
 * `POST /api/kapula/driver/create` — the standalone-driver entry point:
 * instead of a host reading a setup code out of the web app, the driver
 * authenticates with its owner's driver key (`Authorization: Bearer kpk_…`)
 * and the session is created for it. The response is a setup response.
 */
export const kapulaDriverCreateRequestSchema = z.object({
  config: kapulaSessionConfigSchema.default(() =>
    kapulaSessionConfigSchema.parse({}),
  ),
  protocolVersion: z.number().int().positive().optional(),
  /**
   * One active session per owner is the rule. Without this, a second create
   * is refused with 409; with it, the owner's current session ends first
   * (its players are told `host_ended`) — what a game does when it starts
   * again after a crash.
   */
  replaceExisting: z.boolean().default(false),
});
export type KapulaDriverCreateRequest = z.infer<
  typeof kapulaDriverCreateRequestSchema
>;

export type KapulaDriverSetupResponse = {
  /** The version the session speaks; equals the request's when it asked. */
  protocolVersion: number;
  sessionId: string;
  joinCode: string;
  /** Absolute URL players can open (or scan as QR) to join directly. */
  joinUrl: string;
  /** Credential for the driver WebSocket; store it to survive reconnects. */
  driverToken: string;
  /** WebSocket path on the same host, e.g. /api/kapula/ws?role=driver&token=… */
  wsPath: string;
  /** The same socket as an absolute URL — connect to this and skip the join. */
  wsUrl: string;
  /** The host's free-form session metadata, verbatim; omitted when not set. */
  metadata?: string;
};

// --- Player HTTP API (the phone's join surface; see KAPULA.md "Player HTTP API") ---

/**
 * `POST {basePath}/join` — joining takes the code; the server assigns a free
 * "Player N" name and the first free color, which the player customizes in
 * the lobby. In a roster session `name` picks the predefined slot instead
 * (required there; the slot fixes name and color).
 */
export const kapulaJoinRequestSchema = z.object({
  joinCode: kapulaCodeSchema,
  name: kapulaPlayerNameSchema.optional(),
});
export type KapulaJoinRequest = z.infer<typeof kapulaJoinRequestSchema>;

/** What a successful join hands the phone; the token is its credential. */
export const kapulaJoinResultSchema = z.object({
  sessionId: z.string(),
  playerId: z.string(),
  playerToken: z.string(),
});
export type KapulaJoinResult = z.infer<typeof kapulaJoinResultSchema>;

/**
 * `GET {basePath}/join-info/:joinCode` — everything the join screen needs
 * before joining; never exposes tokens. Null for a code that leads nowhere
 * (unknown, ended, or a private session, which the code never confirms).
 */
export const kapulaJoinInfoSchema = z.object({
  state: kapulaSessionStateSchema,
  game: z.string().nullable(),
  maxPlayers: z.number().int(),
  playerCount: z.number().int(),
  /**
   * Whether the session takes a new player right now — the lobby, or a
   * running game the driver opened with `allowLateJoin`. The join screen
   * reads this instead of comparing the state itself.
   */
  acceptingPlayers: z.boolean(),
  availableColors: z.array(kapulaColorSchema),
  schemas: z.array(z.object({ id: z.string(), name: z.string() })),
  /** Driver-predefined slots to pick from; null in a free-join session. */
  roster: z
    .array(z.object({ name: z.string(), color: kapulaColorSchema, taken: z.boolean() }))
    .nullable(),
});
export type KapulaJoinInfo = z.infer<typeof kapulaJoinInfoSchema>;

/** `POST {basePath}/player/status` — does a stored player credential still lead somewhere? */
export const kapulaPlayerStatusRequestSchema = z.object({
  token: z.string().min(1).max(128),
});

export const kapulaPlayerStatusSchema = z.object({
  sessionId: z.string(),
  state: kapulaSessionStateSchema,
  game: z.string().nullable(),
  name: z.string(),
  color: kapulaColorSchema,
});
export type KapulaPlayerStatus = z.infer<typeof kapulaPlayerStatusSchema>;
