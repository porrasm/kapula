import {
  PHYSICAL_GAMEPAD_SCHEMA_ID,
  PHYSICAL_GAMEPAD_SCHEMA_NAME,
  schemaNeedsMotionSensors,
  type KapulaSessionConfig,
} from "@kapula/protocol";

export type SchemaTab = {
  id: string;
  name: string;
  /** True for the player's current schema. */
  current: boolean;
  /** True when the schema can't be selected here (no tilt access, no Gamepad API). */
  disabled: boolean;
};

export type SchemaTabAvailability = {
  /** Motion access is denied or unavailable: tilt schemas are disabled. */
  gyroBlocked?: boolean;
  /** Whether the browser has the Gamepad API (default true). */
  physicalSupported?: boolean;
};

/**
 * The tabs of the slim page strip: one per schema in config order, then the
 * "Real gamepad" entry only when the driver allows it. The one whose id is
 * `currentSchemaId` is marked current. Tabs the picker would disable (tilt
 * schemas when `gyroBlocked`, the gamepad entry when unsupported) are `disabled`.
 */
export const schemaTabs = (
  config: Pick<KapulaSessionConfig, "schemas" | "allowPhysicalGamepad">,
  currentSchemaId: string | undefined,
  availability: SchemaTabAvailability = {},
): SchemaTab[] => {
  const tabs = config.schemas.map((s) => ({
    id: s.id,
    name: s.name,
    current: s.id === currentSchemaId,
    disabled: !!availability.gyroBlocked && schemaNeedsMotionSensors(s),
  }));
  if (config.allowPhysicalGamepad) {
    tabs.push({
      id: PHYSICAL_GAMEPAD_SCHEMA_ID,
      name: PHYSICAL_GAMEPAD_SCHEMA_NAME,
      current: currentSchemaId === PHYSICAL_GAMEPAD_SCHEMA_ID,
      disabled: availability.physicalSupported === false,
    });
  }
  return tabs;
};
