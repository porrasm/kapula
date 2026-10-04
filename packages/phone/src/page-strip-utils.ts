import {
  PHYSICAL_GAMEPAD_SCHEMA_ID,
  PHYSICAL_GAMEPAD_SCHEMA_NAME,
  type KapulaSessionConfig,
} from "@kapula/protocol";

export type SchemaTab = {
  id: string;
  name: string;
  /** True for the player's current schema. */
  current: boolean;
};

/**
 * The tabs of the slim page strip: one per schema in config order, then the
 * "Real gamepad" entry only when the driver allows it. The one whose id is
 * `currentSchemaId` is marked current.
 */
export const schemaTabs = (
  config: Pick<KapulaSessionConfig, "schemas" | "allowPhysicalGamepad">,
  currentSchemaId: string | undefined,
): SchemaTab[] => {
  const tabs = config.schemas.map((s) => ({
    id: s.id,
    name: s.name,
    current: s.id === currentSchemaId,
  }));
  if (config.allowPhysicalGamepad) {
    tabs.push({
      id: PHYSICAL_GAMEPAD_SCHEMA_ID,
      name: PHYSICAL_GAMEPAD_SCHEMA_NAME,
      current: currentSchemaId === PHYSICAL_GAMEPAD_SCHEMA_ID,
    });
  }
  return tabs;
};
