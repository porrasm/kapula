import { hasSchemaChoice, type ControlSchema } from "@kapula/protocol";
import { Button } from "./ui.js";
import { SchemaPicker } from "./SchemaPicker.js";

type SessionMenuProps = {
  /** Forced open while the driver has the game paused: no way to close it. */
  paused: boolean;
  schemas: ControlSchema[];
  /** Adds the "Real gamepad" option to the picker. */
  allowPhysicalGamepad: boolean;
  selectedSchemaId: string | undefined;
  onSelectSchema: (schemaId: string) => void;
  /**
   * Null when there is no layout to edit: a real gamepad is in use, or the
   * driver set `disallowLayoutCustomization`.
   */
  onEditLayout: (() => void) | null;
  /** Present when the current layout has player edits to throw away. */
  onResetLayout: (() => void) | null;
  /** Whether edited layouts outlive this session (driver sent a driverAppUuid). */
  layoutsPersist: boolean;
  onLeave: () => void;
  onClose: () => void;
};

/**
 * The in-game menu, over the controller: the pause overlay grown into a
 * menu the player can open any time from the header. Everything in it works
 * whether or not the driver has the game paused — switching to another
 * layout and editing the current one are both the player's own business.
 * With a real gamepad selected there is no layout, and with
 * `disallowLayoutCustomization` the driver's layout is final: the editing
 * buttons are left out either way.
 */
export const SessionMenu = ({
  paused,
  schemas,
  allowPhysicalGamepad,
  selectedSchemaId,
  onSelectSchema,
  onEditLayout,
  onResetLayout,
  layoutsPersist,
  onLeave,
  onClose,
}: SessionMenuProps) => (
  <div
    className="absolute inset-0 bg-kp-bg-primary/85 flex overflow-y-auto"
    data-testid="session-menu"
    data-paused={paused}
  >
    <div className="m-auto flex flex-col items-center gap-3 p-4">
      <div className="text-lg font-semibold text-kp-text-primary">
        {paused ? "Paused" : "Menu"}
      </div>
      {hasSchemaChoice({ schemas, allowPhysicalGamepad }) && (
        <SchemaPicker
          centered
          schemas={schemas}
          allowPhysicalGamepad={allowPhysicalGamepad}
          selectedId={selectedSchemaId}
          onSelect={onSelectSchema}
        />
      )}
      {onEditLayout && (
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            size="small"
            variant="secondary"
            data-testid="edit-layout"
            onClick={onEditLayout}
          >
            Edit layout
          </Button>
          <Button
            size="small"
            variant="secondary"
            data-testid="reset-layout"
            disabled={onResetLayout === null}
            onClick={() => onResetLayout?.()}
          >
            Reset layout
          </Button>
        </div>
      )}
      {onEditLayout && !layoutsPersist && (
        <p
          className="text-xs text-kp-text-muted text-center"
          data-testid="layout-not-persisted-hint"
        >
          This game does not remember edited layouts — they last until you leave.
        </p>
      )}
      {paused && (
        <p className="text-sm text-kp-text-secondary text-center">
          Only the game can resume the session.
        </p>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        {!paused && (
          <Button size="small" data-testid="close-menu" onClick={onClose}>
            Back to game
          </Button>
        )}
        <Button
          size="small"
          variant="ghost"
          data-testid="leave-session"
          onClick={onLeave}
        >
          Leave session
        </Button>
      </div>
    </div>
  </div>
);
