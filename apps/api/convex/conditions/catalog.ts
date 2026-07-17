import type { PluginAutomationConditionCapability } from '@owlat/plugin-kit';
import { BUNDLED_PLUGIN_AUTOMATION_CONDITION_CATALOG } from '../plugins/automationConditionCatalog.generated';

/**
 * Automation condition-kind catalog. Core condition kinds live in `types.ts`
 * (they back the segment filter validator); this catalog appends the
 * host-composed plugin kinds (empty until a bundled plugin contributes one) and
 * carries their editor + gating metadata. Isolate-safe: metadata only, never the
 * executable modules.
 */

export const CORE_CONDITION_KINDS = [
	'contact_property',
	'email_activity',
	'topic_membership',
] as const;
export type CoreConditionKind = (typeof CORE_CONDITION_KINDS)[number];

type GeneratedPluginConditionKind =
	(typeof BUNDLED_PLUGIN_AUTOMATION_CONDITION_CATALOG)[number] extends infer Entry
		? Entry extends { readonly kind: infer Kind extends string }
			? Kind
			: never
		: never;

export interface GeneratedPluginConditionCatalogEntry {
	readonly kind: string;
	readonly pluginId: string;
	readonly localId: string;
	readonly label: string;
	readonly description: string;
	readonly icon: string;
	readonly requiredEnvVars: readonly string[];
	readonly requiredCapability: PluginAutomationConditionCapability;
}

const PLUGIN_CONDITION_CATALOG =
	BUNDLED_PLUGIN_AUTOMATION_CONDITION_CATALOG as readonly GeneratedPluginConditionCatalogEntry[];

export type PluginConditionKind = GeneratedPluginConditionKind;

export function isCoreConditionKind(kind: string): kind is CoreConditionKind {
	return (CORE_CONDITION_KINDS as readonly string[]).includes(kind);
}

export function isPluginConditionKind(kind: string): kind is GeneratedPluginConditionKind {
	return (
		kind.startsWith('plugin.') && PLUGIN_CONDITION_CATALOG.some((entry) => entry.kind === kind)
	);
}

export function pluginConditionCatalogEntry(
	kind: string
): GeneratedPluginConditionCatalogEntry | undefined {
	return PLUGIN_CONDITION_CATALOG.find((entry) => entry.kind === kind);
}
