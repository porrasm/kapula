import type { GamepadInputValue, GamepadPlayerClientMessage } from "@kapula/protocol";
import { dpadToVector, PHYSICAL_GAMEPAD_CONTROLS } from "@kapula/protocol";
import type { SeqCounter } from "./seq-counter.js";
import { useInputSender } from "./useInputSender.js";
import { usePhysicalGamepad } from "./usePhysicalGamepad.js";
import { useWakeLock } from "./useWakeLock.js";

type PhysicalGamepadPanelProps = {
  send: (msg: GamepadPlayerClientMessage) => void;
  /** Paused sessions and open menus render the panel inert. */
  disabled: boolean;
  /** The lobby trial shows the controller without holding a wake lock. */
  keepAwake?: boolean;
  /** The player session's input seq counter; see seq-counter.ts. */
  seq?: SeqCounter;
};

/**
 * The in-game screen for the "Real gamepad" schema: the phone is a bridge,
 * not a controller, so instead of touch controls it shows which controller
 * is paired and a live readout of what it sends. Polling and mapping live in
 * usePhysicalGamepad.ts; the readout is shared with the debug driver.
 */
export const PhysicalGamepadPanel = ({
  send,
  disabled,
  keepAwake = true,
  seq,
}: PhysicalGamepadPanelProps) => {
  const { setControl } = useInputSender(send, !disabled, seq);
  useWakeLock(keepAwake && !disabled);
  const status = usePhysicalGamepad({ enabled: !disabled, setControl });

  return (
    <div
      className="flex-1 flex flex-col items-center justify-center gap-4 p-4 select-none"
      data-testid="physical-gamepad-panel"
      data-gamepad-id={status.id ?? undefined}
    >
      {!status.supported ? (
        <Notice
          title="No gamepad support"
          body="This browser cannot read controllers. Try another browser, or pick a touch layout from the menu."
        />
      ) : status.id === null ? (
        <Notice
          title="Press any button on your controller"
          body="Pair the controller with this phone over Bluetooth (or plug it in). It shows up here after the first button press."
        />
      ) : (
        <div className="text-center space-y-1">
          <div className="text-xs uppercase tracking-wide text-kp-text-muted">
            Controller
          </div>
          <div
            className="text-sm font-medium text-kp-text-primary"
            data-testid="physical-gamepad-name"
          >
            {status.id}
          </div>
          {!status.standardMapping && (
            <div className="text-xs text-kp-accent-warning">
              Non-standard button layout — some buttons may be mixed up.
            </div>
          )}
        </div>
      )}
      <PhysicalGamepadPreview controls={status.controls} dimmed={disabled} />
    </div>
  );
};

const Notice = ({ title, body }: { title: string; body: string }) => (
  <div className="text-center max-w-xs space-y-1">
    <div className="text-base font-semibold text-kp-text-primary">{title}</div>
    <p className="text-sm text-kp-text-secondary">{body}</p>
  </div>
);

/**
 * A compact readout of a physical gamepad's mapped state: the two sticks,
 * the dpad, the triggers as bars and the buttons as chips. Used by the
 * player's bridge screen and by the admin debug driver's player card.
 */
export const PhysicalGamepadPreview = ({
  controls,
  dimmed = false,
}: {
  controls: Record<string, GamepadInputValue>;
  dimmed?: boolean;
}) => (
  <div
    className={`flex flex-wrap items-center justify-center gap-3 ${dimmed ? "opacity-40" : ""}`}
    data-testid="physical-gamepad-preview"
  >
    {PHYSICAL_GAMEPAD_CONTROLS.map((control) => {
      const value = controls[control.id];
      if (control.kind === "stick" || control.kind === "dpad") {
        const axes =
          typeof value === "string"
            ? dpadToVector(value)
            : typeof value === "object" && value !== null
              ? { x: "x" in value ? value.x : 0, y: "y" in value ? value.y : 0 }
              : { x: 0, y: 0 };
        return (
          <span
            key={control.id}
            className="flex flex-col items-center gap-1"
            title={control.label}
            data-testid={`physical-preview-${control.id}`}
            data-x={axes.x.toFixed(2)}
            data-y={axes.y.toFixed(2)}
          >
            <span
              className={`relative w-12 h-12 bg-kp-bg-tertiary border border-kp-border shrink-0 ${
                control.kind === "dpad" ? "rounded-kp" : "rounded-full"
              }`}
            >
              <span
                className="absolute w-3 h-3 rounded-full bg-kp-accent-primary"
                style={{
                  left: `calc(50% - 6px + ${(axes.x * 17).toFixed(1)}px)`,
                  top: `calc(50% - 6px + ${(axes.y * 17).toFixed(1)}px)`,
                }}
              />
            </span>
            <span className="text-[10px] font-mono text-kp-text-muted">
              {control.label}
            </span>
          </span>
        );
      }
      if (control.kind === "trigger") {
        const pull = typeof value === "number" ? value : 0;
        return (
          <span
            key={control.id}
            className="flex flex-col items-center gap-1"
            title={control.label}
            data-testid={`physical-preview-${control.id}`}
            data-value={pull.toFixed(2)}
          >
            <span className="relative w-4 h-12 rounded-full bg-kp-bg-tertiary border border-kp-border overflow-hidden">
              <span
                className="absolute left-0 right-0 bottom-0 bg-kp-accent-primary"
                style={{ height: `${(pull * 100).toFixed(0)}%` }}
              />
            </span>
            <span className="text-[10px] font-mono text-kp-text-muted">
              {control.label}
            </span>
          </span>
        );
      }
      const active = value === true;
      return (
        <span
          key={control.id}
          className={`px-2 py-1 rounded-kp text-xs font-mono border ${
            active
              ? "bg-kp-accent-primary text-kp-bg-primary border-kp-accent-primary"
              : "bg-kp-bg-tertiary text-kp-text-secondary border-kp-border"
          }`}
          data-testid={`physical-preview-${control.id}`}
          data-active={String(active)}
        >
          {control.label}
        </span>
      );
    })}
  </div>
);
