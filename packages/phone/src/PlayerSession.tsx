import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PHYSICAL_GAMEPAD_SCHEMA_ID,
  type ControlSchema,
  type GamepadPlayerClientMessage,
  type GamepadPlayerInfo,
  type GamepadServerMessage,
  type GamepadSessionSnapshot,
  type GamepadStateChangeReason,
} from "@kapula/protocol";
import { Button, LoadingState } from "./ui.js";
import { Controller } from "./Controller.js";
import { DRIVER_TEXT_MS, parseDriverPayload } from "./driver-payload.js";
import { LayoutEditor } from "./LayoutEditor.js";
import { layoutModeForOrientation } from "./layout-override.js";
import { canCustomizeLayout } from "./layout-utils.js";
import { Lobby } from "./Lobby.js";
import { OrientedSurface, useContentFrame } from "./OrientedSurface.js";
import { PhysicalGamepadPanel } from "./PhysicalGamepadPanel.js";
import { rumblePhysicalGamepad } from "./usePhysicalGamepad.js";
import { SAFE_AREA } from "./safe-area.js";
import { createSeqCounter, type SeqCounter } from "./seq-counter.js";
import { SessionMenu } from "./SessionMenu.js";
import { useLayoutOverride } from "./useLayoutOverride.js";
import { applyServerMessage } from "./snapshot-utils.js";
import { buildGamepadWsUrl, useKapulaConfig } from "./config.js";
import { useGamepadSocket } from "./useGamepadSocket.js";
import {
  clearStoredPlayer,
  shouldDiscardStoredPlayer,
  type StoredPlayer,
} from "./player-storage.js";
import { DRIVER_AWAY_NOTICE, sessionGoneMessage } from "./session-messages.js";
import { useFixedLayerScrollGuard } from "./useViewportGuard.js";

type PlayerSessionProps = {
  player: StoredPlayer;
  onLeave: (message?: string) => void;
};

export const PlayerSession = ({ player, onLeave }: PlayerSessionProps) => {
  const [snapshot, setSnapshot] = useState<GamepadSessionSnapshot | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Bumping the nonce changes the URL, which remounts the socket effect —
  // used by "Use controller here" after another device took the slot over.
  const [retryNonce, setRetryNonce] = useState(0);

  const { apiBase } = useKapulaConfig();
  const url = useMemo(
    () =>
      buildGamepadWsUrl(apiBase, {
        role: "player",
        token: player.token,
        r: String(retryNonce),
      }),
    [apiBase, player.token, retryNonce],
  );

  // The reason of the last state change, read when the session turns out to
  // be gone (the ended state_changed precedes the 4005 close).
  const endReasonRef = useRef<GamepadStateChangeReason | null>(null);

  // One input seq counter for the whole player session: controllers remount
  // on schema switches, and the numbering must not restart with them.
  const seqRef = useRef(createSeqCounter());

  // The driver's { text } line, shown in the in-game header. It expires on
  // its own so a driver that forgets to clear one does not leave it up for
  // the rest of the match; { text: null } clears it at once.
  const [driverText, setDriverText] = useState<string | null>(null);
  const driverTextTimerRef = useRef<number | null>(null);
  const showDriverText = useCallback((text: string | null) => {
    if (driverTextTimerRef.current !== null) {
      window.clearTimeout(driverTextTimerRef.current);
      driverTextTimerRef.current = null;
    }
    setDriverText(text);
    if (text === null) return;
    driverTextTimerRef.current = window.setTimeout(
      () => setDriverText(null),
      DRIVER_TEXT_MS,
    );
  }, []);
  useEffect(
    () => () => {
      if (driverTextTimerRef.current !== null) {
        window.clearTimeout(driverTextTimerRef.current);
      }
    },
    [],
  );

  // Read in onMessage (which holds no snapshot): whether this player is
  // bridging a real controller, so a buzz reaches the right hardware.
  const physicalRef = useRef(false);

  const onMessage = useCallback((msg: GamepadServerMessage) => {
    setSnapshot((prev) => applyServerMessage(prev, msg));
    if (msg.type === "state_changed") {
      endReasonRef.current = msg.reason;
    }
    if (msg.type === "state_changed" && msg.reason === "driver_disconnected") {
      setNotice(DRIVER_AWAY_NOTICE);
    } else if (msg.type === "state_changed") {
      setNotice(null);
    } else if (msg.type === "driver_disconnected") {
      setNotice(DRIVER_AWAY_NOTICE);
    } else if (msg.type === "driver_connected") {
      setNotice(null);
    } else if (msg.type === "error") {
      setNotice(msg.message);
    } else if (msg.type === "message") {
      // Driver → player conventions (driver-payload.ts); anything else in the
      // payload is delivered and ignored, as the relay promises.
      const { vibrateMs, text } = parseDriverPayload(msg.payload);
      if (vibrateMs !== null) {
        if ("vibrate" in navigator) navigator.vibrate(vibrateMs);
        // A phone being used as a bridge is lying on the table; the buzz
        // belongs in the controller the player is actually holding.
        if (physicalRef.current) rumblePhysicalGamepad(vibrateMs);
      }
      if (text !== undefined) showDriverText(text);
    }
  }, []);

  const { isConnected, fatalClose, send } = useGamepadSocket(url, onMessage);

  // Everything below renders in position: fixed layers; a leftover window
  // scroll (the lobby's keyboard, a scrolled landing page) would paint them
  // offset from where touches land. See useViewportGuard.ts.
  useFixedLayerScrollGuard();

  // A gone session (ended live, or the token found dead on reconnect) is not
  // a screen: the credential dies on the spot and the player lands back on
  // the start page — where a new join code goes — with a one-line reason.
  // Nothing about an ended session is ever shown as if it were still there.
  const closeCode = fatalClose?.code ?? null;
  const sessionGone = shouldDiscardStoredPlayer(
    snapshot?.state ?? null,
    closeCode,
  );
  useEffect(() => {
    if (!sessionGone) return;
    clearStoredPlayer();
    onLeave(sessionGoneMessage(endReasonRef.current, closeCode));
    // onLeave is a stable-enough parent callback; re-running on its identity
    // would double-navigate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionGone, closeCode]);

  // Leaving for good: tell the server so the slot (name + color) is freed and
  // the token dies, then drop the stored credential. Best-effort on purpose —
  // send() no-ops on a dead socket, and a player stuck in a broken session
  // must still be able to bail out locally.
  const leave = () => {
    send({ type: "leave" });
    onLeave();
  };

  if (sessionGone) {
    // The effect above is navigating away; render nothing in between.
    return null;
  }

  if (fatalClose) {
    if (fatalClose.code === 4010) {
      return (
        <CenteredMessage
          title="Controller opened on another device"
          body="This player is now controlled elsewhere."
        >
          <Button onClick={() => setRetryNonce((n) => n + 1)}>
            Use controller here
          </Button>
          <Button variant="ghost" onClick={() => onLeave()}>
            Leave session
          </Button>
        </CenteredMessage>
      );
    }
    return (
      <CenteredMessage
        title="Session unavailable"
        body="The connection was refused. Join a new session with a join code."
      >
        <Button onClick={() => onLeave()}>Back to start</Button>
      </CenteredMessage>
    );
  }

  if (!snapshot) {
    // The reconnect loop retries forever on non-fatal closes, so a session
    // that never delivers a snapshot (backend down, corrupted state) must
    // still offer a way out.
    return (
      <div className="flex flex-col items-center gap-4">
        <LoadingState message="Connecting to session…" />
        <Button variant="ghost" data-testid="leave-session" onClick={leave}>
          Leave session
        </Button>
      </div>
    );
  }

  const me = snapshot.players.find((p) => p.playerId === player.playerId);
  const schema =
    snapshot.config.schemas.find((s) => s.id === me?.schemaId) ??
    snapshot.config.schemas[0];
  physicalRef.current = me?.schemaId === PHYSICAL_GAMEPAD_SCHEMA_ID;

  if (snapshot.state === "waiting_for_players") {
    return (
      <div className="fixed inset-0 flex flex-col bg-kp-bg-primary">
        <header
          className="flex items-center gap-2 border-b border-kp-border"
          style={SAFE_AREA.topBar}
        >
          <Identity me={me} isConnected={isConnected} />
          <Button
            size="small"
            variant="ghost"
            data-testid="leave-session"
            onClick={leave}
          >
            Leave
          </Button>
        </header>
        {notice && (
          <div
            className="py-2 text-sm text-kp-accent-warning bg-kp-accent-warning/10"
            style={SAFE_AREA.sides}
            data-testid="session-notice"
          >
            {notice}
          </div>
        )}
        <div className="flex-1 overflow-y-auto" style={SAFE_AREA.edges}>
          <Lobby snapshot={snapshot} playerId={player.playerId} send={send} />
        </div>
      </div>
    );
  }

  if (me?.schemaId === PHYSICAL_GAMEPAD_SCHEMA_ID) {
    // A real gamepad needs no orientation lock or layout: the phone is only
    // the bridge, and the screen shows what the controller sends.
    return (
      <div className="fixed inset-0 flex flex-col bg-kp-bg-primary">
        <InGamePhysical
          snapshot={snapshot}
          me={me}
          isConnected={isConnected}
          notice={notice}
          driverText={driverText}
          send={send}
          seq={seqRef.current}
          onLeave={leave}
        />
      </div>
    );
  }

  // In play the whole screen — header, controller, menu, layout editor —
  // lives on the oriented surface: it freezes the way the phone is held for
  // the schema and pads the safe areas itself, so nothing here uses env().
  return (
    <OrientedSurface schema={schema} className="fixed inset-0 bg-kp-bg-primary">
      <InGame
        snapshot={snapshot}
        me={me}
        schema={schema}
        isConnected={isConnected}
        notice={notice}
        driverText={driverText}
        send={send}
        seq={seqRef.current}
        onLeave={leave}
      />
    </OrientedSurface>
  );
};

const Identity = ({
  me,
  isConnected,
}: {
  me: GamepadPlayerInfo | undefined;
  isConnected: boolean;
}) => (
  <>
    {me && (
      <span
        className="w-3 h-3 rounded-full"
        style={{ backgroundColor: me.color }}
      />
    )}
    <span className="text-sm text-kp-text-primary font-medium flex-1 truncate">
      {me?.name ?? "…"}
    </span>
    <span
      className={`w-2 h-2 rounded-full ${
        isConnected ? "bg-kp-accent-success" : "bg-kp-accent-danger"
      }`}
      title={isConnected ? "Connected" : "Reconnecting…"}
    />
  </>
);

/**
 * The driver's line to this player ("You are Red", a score). Deliberately
 * plain and above the controls: it must never cover a control or move one.
 */
const DriverText = ({
  text,
  style,
}: {
  text: string | null;
  style?: React.CSSProperties;
}) =>
  text === null ? null : (
    <div
      className="py-2 px-4 text-sm text-kp-text-primary bg-kp-bg-secondary text-center truncate"
      style={style}
      data-testid="driver-text"
    >
      {text}
    </div>
  );

type InGameProps = {
  snapshot: GamepadSessionSnapshot;
  me: GamepadPlayerInfo | undefined;
  schema: ControlSchema;
  isConnected: boolean;
  notice: string | null;
  /** The driver's `{ text }` line, shown under the header for a few seconds. */
  driverText: string | null;
  send: (msg: GamepadPlayerClientMessage) => void;
  seq: SeqCounter;
  onLeave: () => void;
};

/**
 * The in-progress / paused screen, inside the oriented surface. Three
 * layers over the controller: the menu (openable any time from the header,
 * forced open while the driver has the game paused — only the game can
 * resume), and the layout editor, which replaces the controller in its exact
 * slot so what is edited is what plays. Edits are keyed by schema and by
 * the layout mode the surface's orientation implies, and outlive the
 * session when the driver identified itself with a driverAppUuid. A driver
 * that set `disallowLayoutCustomization` gets neither: the editor is not
 * offered and stored edits are not applied.
 */
const InGame = ({
  snapshot,
  me,
  schema,
  isConnected,
  notice,
  driverText,
  send,
  seq,
  onLeave,
}: InGameProps) => {
  const frame = useContentFrame();
  const layout = useLayoutOverride({
    driverAppUuid: snapshot.config.driverAppUuid,
    schemaId: schema.id,
    mode: layoutModeForOrientation(frame.orientation),
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const customizable = canCustomizeLayout(snapshot.config, schema);

  const paused = snapshot.state === "paused";
  const menuVisible = !editing && (paused || menuOpen);

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
      <header
        className="flex items-center gap-2 border-b border-kp-border"
        style={{ padding: "0.5rem 1rem" }}
      >
        <Identity me={me} isConnected={isConnected} />
        <Button
          size="small"
          variant="ghost"
          data-testid="open-menu"
          disabled={menuVisible}
          onClick={() => setMenuOpen(true)}
        >
          Menu
        </Button>
      </header>
      {notice && (
        <div
          className="py-2 px-4 text-sm text-kp-accent-warning bg-kp-accent-warning/10"
          data-testid="session-notice"
        >
          {notice}
        </div>
      )}
      <DriverText text={driverText} />
      <div className="flex-1 flex flex-col relative min-h-0">
        <Controller
          // Remounted per schema: a switch mid-game must not keep sending the
          // previous layout's control ids in every frame. The seq counter is
          // the session's, so the numbering carries on across the remount.
          key={schema.id}
          schema={schema}
          send={send}
          disabled={menuVisible}
          layoutOverride={customizable ? layout.override : null}
          seq={seq}
          background={snapshot.background}
        />
        {menuVisible && (
          <SessionMenu
            paused={paused}
            schemas={snapshot.config.schemas}
            allowPhysicalGamepad={snapshot.config.allowPhysicalGamepad}
            selectedSchemaId={me?.schemaId}
            onSelectSchema={(schemaId) => send({ type: "select_schema", schemaId })}
            onEditLayout={
              customizable
                ? () => {
                    setMenuOpen(false);
                    setEditing(true);
                  }
                : null
            }
            onResetLayout={customizable && layout.hasEdits ? layout.reset : null}
            layoutsPersist={layout.persisted}
            onLeave={onLeave}
            onClose={() => setMenuOpen(false)}
          />
        )}
      </div>
    </>
  );
};

/**
 * The in-progress / paused screen for the "Real gamepad" schema. Same header
 * and menu as the touch screen (the menu is where a player switches back to
 * a touch layout), the bridge panel where the controller goes,
 * and no layout editor — there is nothing on screen to move.
 */
const InGamePhysical = ({
  snapshot,
  me,
  isConnected,
  notice,
  driverText,
  send,
  seq,
  onLeave,
}: Omit<InGameProps, "schema">) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const paused = snapshot.state === "paused";
  const menuVisible = paused || menuOpen;

  return (
    <>
      <header
        className="flex items-center gap-2 border-b border-kp-border"
        style={SAFE_AREA.topBar}
      >
        <Identity me={me} isConnected={isConnected} />
        <Button
          size="small"
          variant="ghost"
          data-testid="open-menu"
          disabled={menuVisible}
          onClick={() => setMenuOpen(true)}
        >
          Menu
        </Button>
      </header>
      {notice && (
        <div
          className="py-2 text-sm text-kp-accent-warning bg-kp-accent-warning/10"
          style={SAFE_AREA.sides}
          data-testid="session-notice"
        >
          {notice}
        </div>
      )}
      <DriverText text={driverText} style={SAFE_AREA.sides} />
      <div className="flex-1 flex flex-col relative min-h-0" style={SAFE_AREA.edges}>
        <PhysicalGamepadPanel send={send} disabled={menuVisible} seq={seq} />
        {menuVisible && (
          <SessionMenu
            paused={paused}
            schemas={snapshot.config.schemas}
            allowPhysicalGamepad={snapshot.config.allowPhysicalGamepad}
            selectedSchemaId={me?.schemaId}
            onSelectSchema={(schemaId) => send({ type: "select_schema", schemaId })}
            onEditLayout={null}
            onResetLayout={null}
            layoutsPersist
            onLeave={onLeave}
            onClose={() => setMenuOpen(false)}
          />
        )}
      </div>
    </>
  );
};

const CenteredMessage = ({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: React.ReactNode;
}) => (
  <div className="p-6 max-w-md mx-auto flex flex-col items-center gap-4 text-center">
    <h1 className="text-xl font-semibold text-kp-text-primary">{title}</h1>
    <p className="text-sm text-kp-text-secondary">{body}</p>
    {children}
  </div>
);
