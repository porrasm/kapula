import { schemaTabs } from "./page-strip-utils.js";
import { useSchemaSelect } from "./SchemaPicker.js";
import { Button } from "./ui.js";
import { isPhysicalGamepadSupported } from "./usePhysicalGamepad.js";
import type { KapulaSessionConfig } from "@kapula/protocol";

export { schemaTabs, type SchemaTab } from "./page-strip-utils.js";

type PageStripProps = {
  config: Pick<KapulaSessionConfig, "schemas" | "allowPhysicalGamepad" | "game">;
  currentSchemaId: string | undefined;
  onSelectSchema: (schemaId: string) => void;
  menuDisabled: boolean;
  onOpenMenu: () => void;
  /** The driver's `{ text }` line; overlays the strip while set. */
  driverText: string | null;
  style?: React.CSSProperties;
};

/**
 * The slim chrome (`config.chrome: "slim"`): a 28 px strip with the game name,
 * the schemas as horizontal tabs and a small Menu button.
 */
export const PageStrip = ({
  config,
  currentSchemaId,
  onSelectSchema,
  menuDisabled,
  onOpenMenu,
  driverText,
  style,
}: PageStripProps) => {
  const { blocked, selectById } = useSchemaSelect(config.schemas, onSelectSchema);
  const tabs = schemaTabs(config, currentSchemaId, {
    gyroBlocked: blocked,
    physicalSupported: isPhysicalGamepadSupported(),
  });
  return (
    <header
      className="relative flex items-center gap-2 px-2 border-b border-kp-border shrink-0 overflow-hidden"
      style={{ height: 28, ...style }}
      data-testid="page-strip"
    >
      <span className="text-xs text-kp-text-primary font-medium truncate max-w-[25%]">
        {config.game ?? ""}
      </span>
      <nav className="flex-1 flex items-center justify-center gap-1 min-w-0 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`px-2 h-5 rounded text-xs whitespace-nowrap disabled:opacity-40 ${
              tab.current
                ? "bg-kp-accent-primary text-kp-text-primary"
                : "text-kp-text-secondary"
            }`}
            aria-current={tab.current ? "page" : undefined}
            data-testid={`page-tab-${tab.id}`}
            disabled={tab.disabled}
            onClick={() => selectById(tab.id)}
          >
            {tab.name}
          </button>
        ))}
      </nav>
      <Button
        size="small"
        variant="ghost"
        className="!py-0 !px-2 !text-xs !min-h-0 h-5"
        data-testid="open-menu"
        disabled={menuDisabled}
        onClick={onOpenMenu}
      >
        Menu
      </Button>
      {driverText !== null && (
        <div
          className="absolute inset-0 flex items-center justify-center px-4 text-xs text-kp-text-primary bg-kp-bg-secondary truncate"
          data-testid="driver-text"
        >
          {driverText}
        </div>
      )}
    </header>
  );
};
