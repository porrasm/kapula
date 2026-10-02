import { useEffect, useState } from "react";
import {
  GAMEPAD_PLAYER_NAME_MAX_LENGTH,
  gamepadPlayerNameSchema,
  getSessionColors,
  hasSchemaChoice,
  PHYSICAL_GAMEPAD_SCHEMA_ID,
  PHYSICAL_GAMEPAD_SCHEMA_NAME,
  type ControlSchema,
  type GamepadBackground,
  type GamepadPlayerClientMessage,
  type GamepadSessionSnapshot,
} from "@kapula/protocol";
import { Button } from "./ui.js";
import { Controller } from "./Controller.js";
import { LayoutEditor } from "./LayoutEditor.js";
import { layoutModeForOrientation } from "./layout-override.js";
import { canCustomizeLayout } from "./layout-utils.js";
import { MissingRoster, PlayerList } from "./PlayerList.js";
import { OrientedSurface, useContentFrame } from "./OrientedSurface.js";
import { PhysicalGamepadPanel } from "./PhysicalGamepadPanel.js";
import { DRIVER_LOST_MINUTES } from "./session-messages.js";
import { SchemaPicker } from "./SchemaPicker.js";
import { useLayoutOverride } from "./useLayoutOverride.js";

type LobbyProps = {
  snapshot: GamepadSessionSnapshot;
  playerId: string;
  send: (msg: GamepadPlayerClientMessage) => void;
};

/** Trial input stays on the phone — the game hasn't started, nothing listens. */
const NOOP_SEND = () => {};

/**
 * One screen for everything pre-game: name, color and the ready toggle.
 * Readying up locks the profile; unready to change name or color again.
 */
export const Lobby = ({ snapshot, playerId, send }: LobbyProps) => {
  const me = snapshot.players.find((p) => p.playerId === playerId);

  const [nameDraft, setNameDraft] = useState(me?.name ?? "");
  const [editingName, setEditingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [trying, setTrying] = useState(false);

  // Follow server-side renames (rejected updates included) while not typing.
  const serverName = me?.name ?? "";
  useEffect(() => {
    if (!editingName) setNameDraft(serverName);
  }, [serverName, editingName]);

  if (!me) return null;

  const commitName = () => {
    setEditingName(false);
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === me.name) return;
    const parsed = gamepadPlayerNameSchema.safeParse(trimmed);
    if (!parsed.success) {
      setNameError(
        parsed.error.issues[0]?.message ?? "That name is not allowed",
      );
      return;
    }
    send({ type: "update_profile", name: parsed.data });
  };

  const trialSchema =
    snapshot.config.schemas.find((s) => s.id === me.schemaId) ??
    snapshot.config.schemas[0];

  const palette = getSessionColors(snapshot.config);
  const takenByOthers = new Set(
    snapshot.players
      .filter((p) => p.playerId !== playerId)
      .map((p) => p.color),
  );
  // A roster session fixed name and color at join; nothing to edit here.
  const rosterLocked = snapshot.config.roster !== undefined;

  return (
    <div className="p-4 max-w-md mx-auto space-y-4">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-kp-text-primary">
          {snapshot.config.game ?? "Game lobby"}
        </h1>
        <p className="text-sm text-kp-text-secondary">
          {snapshot.driverConnected
            ? rosterLocked
              ? "The game starts once every player has joined and is ready."
              : "The game starts once everyone is ready."
            : `Waiting for the game to reconnect… if it stays away for ${DRIVER_LOST_MINUTES} minutes, the session closes.`}
        </p>
      </div>

      {rosterLocked ? (
        <div
          className="flex items-center gap-2 rounded-kp bg-kp-bg-secondary px-3 py-2"
          data-testid="roster-identity"
        >
          <span
            className="w-4 h-4 rounded-full shrink-0"
            style={{ backgroundColor: me.color }}
          />
          <span className="text-sm text-kp-text-primary">
            You are <b>{me.name}</b>
          </span>
          <span className="text-xs text-kp-text-muted ml-auto">
            set by the game
          </span>
        </div>
      ) : (
        <>
          <label className="block space-y-1">
            <span className="text-sm text-kp-text-secondary">Your name</span>
            <input
              className="w-full rounded-kp bg-kp-bg-tertiary border border-kp-border px-3 py-2 text-kp-text-primary disabled:opacity-50"
              value={nameDraft}
              maxLength={GAMEPAD_PLAYER_NAME_MAX_LENGTH}
              disabled={me.ready}
              data-testid="player-name-input"
              onFocus={() => {
                setEditingName(true);
                setNameError(null);
              }}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
            {nameError && (
              <span className="text-sm text-kp-accent-danger">{nameError}</span>
            )}
          </label>

          <div className="space-y-1">
            <span className="text-sm text-kp-text-secondary">Color</span>
            <div className="flex flex-wrap gap-2" data-testid="color-picker">
              {palette.map((color) => {
                const taken = takenByOthers.has(color);
                return (
                  <button
                    key={color}
                    type="button"
                    aria-label={`color ${color}`}
                    disabled={taken || me.ready}
                    className={`w-9 h-9 rounded-full border-2 ${
                      color === me.color
                        ? "border-kp-text-primary scale-110"
                        : "border-transparent"
                    } ${taken ? "opacity-30" : ""} disabled:cursor-not-allowed`}
                    style={{ backgroundColor: color }}
                    onClick={() => send({ type: "update_profile", color })}
                  />
                );
              })}
            </div>
          </div>
        </>
      )}

      <div className="space-y-2">
        {hasSchemaChoice(snapshot.config) && (
          <>
            <div className="text-sm text-kp-text-secondary">
              Controller layout
            </div>
            <SchemaPicker
              schemas={snapshot.config.schemas}
              allowPhysicalGamepad={snapshot.config.allowPhysicalGamepad}
              selectedId={me.schemaId}
              onSelect={(schemaId) => send({ type: "select_schema", schemaId })}
            />
          </>
        )}
        <Button
          fullWidth
          variant="secondary"
          data-testid="try-controller"
          onClick={() => setTrying(true)}
        >
          Try the controller
        </Button>
      </div>

      <PlayerList players={snapshot.players} selfId={playerId} showReady />
      <MissingRoster snapshot={snapshot} />

      <Button
        fullWidth
        size="large"
        variant={me.ready ? "secondary" : "success"}
        onClick={() => send({ type: "set_ready", ready: !me.ready })}
        data-testid="ready-toggle"
      >
        {me.ready ? "Not ready after all" : "I'm ready"}
      </Button>

      {trying && me.schemaId === PHYSICAL_GAMEPAD_SCHEMA_ID ? (
        <PhysicalTrial onClose={() => setTrying(false)} />
      ) : trying && (
        <TrialController
          schema={trialSchema}
          driverAppUuid={snapshot.config.driverAppUuid}
          customizable={canCustomizeLayout(snapshot.config, trialSchema)}
          background={snapshot.background}
          onClose={() => setTrying(false)}
        />
      )}
    </div>
  );
};

/**
 * Full-screen local try-out of the player's current control layout, so the
 * feel of a layout can inform the pick before readying up. The real
 * controller renders (layout engine, gyro chip and all) but its input goes
 * nowhere — the driver only receives frames once the game is in progress.
 */
const TrialController = ({
  schema,
  driverAppUuid,
  customizable,
  background,
  onClose,
}: {
  schema: ControlSchema;
  driverAppUuid: string | undefined;
  customizable: boolean;
  background: GamepadBackground | undefined;
  onClose: () => void;
}) => (
  // The surface owns orientation and pads the safe areas itself, exactly as
  // in the real game, so the trial shows the layout the way it will play.
  // Everything else lives inside it: the header belongs to the surface's
  // coordinate space, and the layout editor needs the surface's orientation
  // to know which of the two layout drafts it is editing.
  <OrientedSurface schema={schema} className="fixed inset-0 z-50 bg-kp-bg-primary">
    <TrialSurface
      schema={schema}
      driverAppUuid={driverAppUuid}
      customizable={customizable}
      background={background}
      onClose={onClose}
    />
  </OrientedSurface>
);

/**
 * The "Real gamepad" trial: no layout to try, but the place to check that
 * the paired controller is seen and every button reads as expected before
 * readying up. Like the touch trial, nothing reaches the game.
 */
const PhysicalTrial = ({ onClose }: { onClose: () => void }) => (
  <div className="fixed inset-0 z-50 flex flex-col bg-kp-bg-primary">
    <header className="flex items-center gap-2 border-b border-kp-border px-4 py-2">
      <span className="text-sm text-kp-text-primary flex-1 truncate">
        Trying <b>{PHYSICAL_GAMEPAD_SCHEMA_NAME}</b> — nothing is sent to the game
      </span>
      <Button
        size="small"
        variant="secondary"
        data-testid="close-try-controller"
        onClick={onClose}
      >
        Done
      </Button>
    </header>
    <div className="flex-1 flex flex-col min-h-0">
      <PhysicalGamepadPanel send={NOOP_SEND} disabled={false} keepAwake={false} />
    </div>
  </div>
);

/**
 * Inside the surface: the trial plays the layout the player edited in-game —
 * and lets them edit it right here, which is where a layout that feels wrong
 * is usually noticed. It is the same editor, the same storage and the same
 * layout draft as the in-game menu's; the only difference is that nothing is
 * being played while you work. Not customizable (the driver set
 * `disallowLayoutCustomization`): no editor, no stored edits, just the trial.
 */
const TrialSurface = ({
  schema,
  driverAppUuid,
  customizable,
  background,
  onClose,
}: {
  schema: ControlSchema;
  driverAppUuid: string | undefined;
  customizable: boolean;
  background: GamepadBackground | undefined;
  onClose: () => void;
}) => {
  const frame = useContentFrame();
  const layout = useLayoutOverride({
    driverAppUuid,
    schemaId: schema.id,
    mode: layoutModeForOrientation(frame.orientation),
  });
  const [editing, setEditing] = useState(false);

  // The editor brings its own header, in the same slot, so what is edited
  // stays exactly where it will be played.
  if (editing && customizable) {
    return (
      <LayoutEditor
        schema={schema}
        layout={layout}
        onDone={() => setEditing(false)}
      />
    );
  }

  return (
    <>
      <header className="flex items-center gap-2 border-b border-kp-border px-4 py-2">
        <span className="text-sm text-kp-text-primary flex-1 truncate">
          Trying <b>{schema.name}</b> — nothing is sent to the game
        </span>
        {customizable && (
          <Button
            size="small"
            variant="secondary"
            data-testid="trial-edit-layout"
            onClick={() => setEditing(true)}
          >
            Edit layout
          </Button>
        )}
        <Button
          size="small"
          variant="secondary"
          data-testid="close-try-controller"
          onClick={onClose}
        >
          Done
        </Button>
      </header>
      {customizable && !layout.persisted && (
        <p
          className="text-xs text-kp-text-muted text-center px-4 py-1"
          data-testid="trial-layout-not-persisted-hint"
        >
          This game does not remember edited layouts — they last until you
          leave.
        </p>
      )}
      <div className="flex-1 flex flex-col min-h-0">
        <Controller
          schema={schema}
          send={NOOP_SEND}
          disabled={false}
          keepAwake={false}
          layoutOverride={customizable ? layout.override : null}
          background={background}
        />
      </div>
    </>
  );
};
