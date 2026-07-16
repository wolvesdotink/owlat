import { BUNDLED_PLUGIN_AUTOMATION_TRIGGER_CATALOG } from '../../../../api/convex/plugins/automationTriggerCatalog.generated';
import { BUNDLED_PLUGIN_AUTOMATION_STEP_CATALOG } from '../../../../api/convex/plugins/automationStepCatalog.generated';
import { BUNDLED_PLUGIN_AUTOMATION_CONDITION_CATALOG } from '../../../../api/convex/plugins/automationConditionCatalog.generated';

/**
 * Editor metadata for host-composed plugin automation contributions, connected
 * to the automation builder. The values come straight from the generated
 * metadata catalogs (pure data — no Convex validator, no executable module), so
 * the builder can list a plugin's triggers, steps, and conditions with a label,
 * description, and icon without importing any plugin code. Empty until a bundled
 * plugin contributes an automation kind.
 *
 * The `label`/`description` text originates in a plugin manifest and is bounded
 * by the manifest validator; treat it as untrusted at render time (text nodes,
 * never `v-html`).
 */
export interface AutomationPluginPaletteEntry {
	readonly kind: string;
	readonly label: string;
	readonly description: string;
	readonly icon: string;
}

interface GeneratedEditorCatalogEntry {
	readonly kind: string;
	readonly label: string;
	readonly description: string;
	readonly icon: string;
}

function toPaletteEntries(
	catalog: readonly GeneratedEditorCatalogEntry[]
): readonly AutomationPluginPaletteEntry[] {
	return Object.freeze(
		catalog.map((entry) =>
			Object.freeze({
				kind: entry.kind,
				label: entry.label,
				description: entry.description,
				icon: entry.icon,
			})
		)
	);
}

export interface AutomationPluginPalette {
	readonly triggers: readonly AutomationPluginPaletteEntry[];
	readonly steps: readonly AutomationPluginPaletteEntry[];
	readonly conditions: readonly AutomationPluginPaletteEntry[];
}

/** Palette entries for every composed plugin automation kind, grouped by registry. */
export function useAutomationPluginPalette(): AutomationPluginPalette {
	return {
		triggers: toPaletteEntries(
			BUNDLED_PLUGIN_AUTOMATION_TRIGGER_CATALOG as readonly GeneratedEditorCatalogEntry[]
		),
		steps: toPaletteEntries(
			BUNDLED_PLUGIN_AUTOMATION_STEP_CATALOG as readonly GeneratedEditorCatalogEntry[]
		),
		conditions: toPaletteEntries(
			BUNDLED_PLUGIN_AUTOMATION_CONDITION_CATALOG as readonly GeneratedEditorCatalogEntry[]
		),
	};
}
