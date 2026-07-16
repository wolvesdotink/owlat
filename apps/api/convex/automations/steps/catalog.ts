import { v } from 'convex/values';
import type { PluginAutomationStepCapability, PluginId } from '@owlat/plugin-kit';
import { BUNDLED_PLUGIN_AUTOMATION_STEP_CATALOG } from '../../plugins/automationStepCatalog.generated';

/**
 * Automation step-kind catalog — the open set of step kinds the editor and the
 * walker recognise. Core kinds are declared here; plugin kinds are appended from
 * the generated composition (empty until a bundled plugin contributes one). This
 * is the isolate-safe half: it imports only the metadata catalog, never the
 * Node-only executable modules, so schema and mutation code can derive the
 * persisted-kind validator from it.
 *
 * Mirrors `agent/steps/catalog.ts` (PP-08) and `lib/sendProviders/catalog.ts`
 * (PP-07): one registry is the single source of truth for the kind union, the
 * Convex validator, and the runtime lookups.
 */

export const CORE_STEP_KINDS = ['email', 'delay', 'condition'] as const;
export type CoreStepKind = (typeof CORE_STEP_KINDS)[number];

type GeneratedPluginStepKind =
	(typeof BUNDLED_PLUGIN_AUTOMATION_STEP_CATALOG)[number] extends infer Entry
		? Entry extends { readonly kind: infer Kind extends string }
			? Kind
			: never
		: never;

/** Editor metadata + gating metadata copied verbatim from the plugin manifest. */
export interface GeneratedPluginStepCatalogEntry {
	readonly kind: string;
	readonly pluginId: string;
	readonly localId: string;
	readonly label: string;
	readonly description: string;
	readonly icon: string;
	readonly requiredEnvVars: readonly string[];
	readonly requiredCapability: PluginAutomationStepCapability;
}

const PLUGIN_STEP_CATALOG =
	BUNDLED_PLUGIN_AUTOMATION_STEP_CATALOG as readonly GeneratedPluginStepCatalogEntry[];

export type StepKind = CoreStepKind | GeneratedPluginStepKind;

export const STEP_KINDS = Object.freeze([
	...CORE_STEP_KINDS,
	...PLUGIN_STEP_CATALOG.map((entry) => entry.kind as GeneratedPluginStepKind),
]) as readonly StepKind[];

/** Persisted-kind validator for `automationSteps.stepType`; widens as plugins compose. */
export const stepKindValidator = v.union(...STEP_KINDS.map((kind) => v.literal(kind)));

export function isCoreStepKind(kind: string): kind is CoreStepKind {
	return (CORE_STEP_KINDS as readonly string[]).includes(kind);
}

export function isPluginStepKind(kind: string): kind is GeneratedPluginStepKind {
	return kind.startsWith('plugin.') && PLUGIN_STEP_CATALOG.some((entry) => entry.kind === kind);
}

export function pluginStepCatalogEntry(kind: string): GeneratedPluginStepCatalogEntry | undefined {
	return PLUGIN_STEP_CATALOG.find((entry) => entry.kind === kind);
}

/** The plugin that owns a plugin step kind, or undefined for core/unknown kinds. */
export function stepPluginId(kind: string): PluginId | undefined {
	return pluginStepCatalogEntry(kind)?.pluginId as PluginId | undefined;
}

/** Editor palette entries for plugin step kinds; consumed by the automation builder. */
export const PLUGIN_STEP_EDITOR_CATALOG = Object.freeze(
	PLUGIN_STEP_CATALOG.map((entry) =>
		Object.freeze({
			kind: entry.kind,
			label: entry.label,
			description: entry.description,
			icon: entry.icon,
		})
	)
);
