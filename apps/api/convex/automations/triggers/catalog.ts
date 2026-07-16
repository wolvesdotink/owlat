import { v } from 'convex/values';
import type { PluginAutomationTriggerCapability, PluginId } from '@owlat/plugin-kit';
import { BUNDLED_PLUGIN_AUTOMATION_TRIGGER_CATALOG } from '../../plugins/automationTriggerCatalog.generated';

/**
 * Automation trigger-kind catalog. Core trigger kinds are declared here; plugin
 * kinds are appended from the generated composition (empty until a bundled
 * plugin contributes one). Isolate-safe: imports only the metadata catalog, so
 * the schema can derive the persisted `triggerType` validator from it.
 */

export const CORE_TRIGGER_KINDS = [
	'contact_created',
	'contact_updated',
	'event_received',
	'topic_subscribed',
] as const;
export type CoreTriggerKind = (typeof CORE_TRIGGER_KINDS)[number];

type GeneratedPluginTriggerKind =
	(typeof BUNDLED_PLUGIN_AUTOMATION_TRIGGER_CATALOG)[number] extends infer Entry
		? Entry extends { readonly kind: infer Kind extends string }
			? Kind
			: never
		: never;

export interface GeneratedPluginTriggerCatalogEntry {
	readonly kind: string;
	readonly pluginId: string;
	readonly localId: string;
	readonly label: string;
	readonly description: string;
	readonly icon: string;
	readonly requiredEnvVars: readonly string[];
	readonly requiredCapability: PluginAutomationTriggerCapability;
}

const PLUGIN_TRIGGER_CATALOG =
	BUNDLED_PLUGIN_AUTOMATION_TRIGGER_CATALOG as readonly GeneratedPluginTriggerCatalogEntry[];

export type TriggerKind = CoreTriggerKind | GeneratedPluginTriggerKind;

export const TRIGGER_KINDS = Object.freeze([
	...CORE_TRIGGER_KINDS,
	...PLUGIN_TRIGGER_CATALOG.map((entry) => entry.kind as GeneratedPluginTriggerKind),
]) as readonly TriggerKind[];

/** Persisted-kind validator for `automations.triggerType`; widens as plugins compose. */
export const triggerKindValidator = v.union(...TRIGGER_KINDS.map((kind) => v.literal(kind)));

export function isCoreTriggerKind(kind: string): kind is CoreTriggerKind {
	return (CORE_TRIGGER_KINDS as readonly string[]).includes(kind);
}

export function isPluginTriggerKind(kind: string): kind is GeneratedPluginTriggerKind {
	return kind.startsWith('plugin.') && PLUGIN_TRIGGER_CATALOG.some((entry) => entry.kind === kind);
}

export function pluginTriggerCatalogEntry(
	kind: string
): GeneratedPluginTriggerCatalogEntry | undefined {
	return PLUGIN_TRIGGER_CATALOG.find((entry) => entry.kind === kind);
}

export function triggerPluginId(kind: string): PluginId | undefined {
	return pluginTriggerCatalogEntry(kind)?.pluginId as PluginId | undefined;
}

/** Editor palette entries for plugin trigger kinds; consumed by the automation builder. */
export const PLUGIN_TRIGGER_EDITOR_CATALOG = Object.freeze(
	PLUGIN_TRIGGER_CATALOG.map((entry) =>
		Object.freeze({
			kind: entry.kind,
			label: entry.label,
			description: entry.description,
			icon: entry.icon,
		})
	)
);
