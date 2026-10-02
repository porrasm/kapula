import {
  PHYSICAL_GAMEPAD_SCHEMA_ID,
  PHYSICAL_GAMEPAD_SCHEMA_NAME,
  schemaNeedsMotionSensors,
  type ControlSchema,
} from "@kapula/protocol";
import { Button } from "./ui.js";
import { requestGyroAccess, useGyroAccess } from "./useGyro.js";
import { isPhysicalGamepadSupported } from "./usePhysicalGamepad.js";

type SchemaPickerProps = {
  schemas: ControlSchema[];
  /** Adds the "Real gamepad" option (the driver's `allowPhysicalGamepad`). */
  allowPhysicalGamepad?: boolean;
  selectedId: string | undefined;
  onSelect: (schemaId: string) => void;
  /** The in-game menu centers its content; the lobby is left-aligned. */
  centered?: boolean;
};

/**
 * The secondary variant has a 1px border and the primary one has none, so
 * swapping variants on select would shift the button by 2px and reflow the
 * wrapped rows on narrow screens. An invisible border keeps both the same size.
 */
const SELECTED_BORDER = "border border-transparent";

/**
 * The control-layout buttons shown in the lobby and in the in-game menu.
 * Layouts with a gyro control carry a tilt badge, and are gated on motion
 * access: on iOS the selecting tap doubles as the user gesture the permission
 * prompt requires, and a device that can't deliver tilt (no sensor, or
 * access denied) gets the layout disabled instead of a controller with a
 * dead control. When the driver allows it, a "Real gamepad" option follows
 * the layouts — a controller paired with the phone instead of touch — gated
 * on the browser having the Gamepad API at all.
 */
export const SchemaPicker = ({
  schemas,
  allowPhysicalGamepad = false,
  selectedId,
  onSelect,
  centered = false,
}: SchemaPickerProps) => {
  const access = useGyroAccess();
  const blocked = access === "denied" || access === "unavailable";
  const anyGyro = schemas.some(schemaNeedsMotionSensors);
  const physicalSupported = isPhysicalGamepadSupported();

  const select = async (schema: ControlSchema) => {
    if (schemaNeedsMotionSensors(schema) && access !== "granted") {
      // Resolves instantly when no permission gate exists; otherwise this tap
      // is the required gesture. Only a verified sensor selects the layout.
      if ((await requestGyroAccess()) !== "granted") return;
    }
    onSelect(schema.id);
  };

  return (
    <div className="space-y-2">
      <div className={`flex flex-wrap gap-2 ${centered ? "justify-center" : ""}`}>
        {schemas.map((schema) => {
          const gyro = schemaNeedsMotionSensors(schema);
          const selected = schema.id === selectedId;
          return (
            <Button
              key={schema.id}
              size="small"
              variant={selected ? "primary" : "secondary"}
              className={selected ? SELECTED_BORDER : ""}
              disabled={gyro && blocked}
              data-testid={`schema-option-${schema.id}`}
              onClick={() => void select(schema)}
            >
              {schema.name}
              {gyro && (
                <span
                  className="ml-1.5 text-[10px] uppercase tracking-wide opacity-80"
                  data-testid={`schema-tilt-badge-${schema.id}`}
                >
                  ⟲ tilt
                </span>
              )}
            </Button>
          );
        })}
        {allowPhysicalGamepad && (
          <Button
            size="small"
            variant={
              selectedId === PHYSICAL_GAMEPAD_SCHEMA_ID ? "primary" : "secondary"
            }
            className={
              selectedId === PHYSICAL_GAMEPAD_SCHEMA_ID ? SELECTED_BORDER : ""
            }
            disabled={!physicalSupported}
            data-testid={`schema-option-${PHYSICAL_GAMEPAD_SCHEMA_ID}`}
            onClick={() => onSelect(PHYSICAL_GAMEPAD_SCHEMA_ID)}
          >
            🎮 {PHYSICAL_GAMEPAD_SCHEMA_NAME}
          </Button>
        )}
      </div>
      {anyGyro && blocked && (
        <p
          className={`text-xs text-kp-text-muted ${centered ? "text-center" : ""}`}
          data-testid="gyro-blocked-hint"
        >
          {access === "denied"
            ? "Layouts marked ⟲ steer by tilting the phone — motion access was denied on this device."
            : "Layouts marked ⟲ steer by tilting the phone, which this device does not support."}
        </p>
      )}
      {allowPhysicalGamepad && (
        <p
          className={`text-xs text-kp-text-muted ${centered ? "text-center" : ""}`}
          data-testid="physical-gamepad-hint"
        >
          {physicalSupported
            ? "Real gamepad: play with a controller paired to this phone over Bluetooth or USB."
            : "Real gamepad needs a browser that can read controllers — this one cannot."}
        </p>
      )}
    </div>
  );
};
