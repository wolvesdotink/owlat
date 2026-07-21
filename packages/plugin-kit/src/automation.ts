import type { PluginLocalId, PluginNamespacedKind } from './namespacedKind';
import type { JsonObject, JsonValue } from './json';
import type { PluginStaticModuleExport } from './sendTransport';

/**
 * Capabilities the host assigns to bundled automation contributions. Each
 * automation registry (triggers, steps, conditions) has its own capability so
 * an operator grant can enable one kind of contribution without the others.
 */
export const PLUGIN_AUTOMATION_TRIGGER_CAPABILITY = 'automation:trigger' as const;
export const PLUGIN_AUTOMATION_STEP_CAPABILITY = 'automation:step' as const;
export const PLUGIN_AUTOMATION_CONDITION_CAPABILITY = 'automation:condition' as const;

export type PluginAutomationTriggerCapability = typeof PLUGIN_AUTOMATION_TRIGGER_CAPABILITY;
export type PluginAutomationStepCapability = typeof PLUGIN_AUTOMATION_STEP_CAPABILITY;
export type PluginAutomationConditionCapability = typeof PLUGIN_AUTOMATION_CONDITION_CAPABILITY;

/** Local contribution identity; the host namespaces it with the owning plugin id. */

/** Collision-safe kinds persisted on automation rows, steps, and segment filters. */
export type PluginAutomationTriggerKind = PluginNamespacedKind;
export type PluginAutomationStepKind = PluginNamespacedKind;
export type PluginAutomationConditionKind = PluginNamespacedKind;

/**
 * Editor metadata connected to the automation builder palette. The host copies
 * these fields verbatim into the generated catalog so the frontend can render a
 * plugin contribution without importing plugin code. Free text is bounded by the
 * manifest validator; the frontend still treats it as untrusted at render time.
 */
export interface PluginAutomationEditorMetadata {
	readonly label: string;
	readonly description: string;
	/** Icon slug resolved against the shared icon set; never a URL or markup. */
	readonly icon: string;
}

/** Trigger data merged onto an automation run; primitives only, never objects. */
export type PluginAutomationTriggerData = Readonly<
	Record<string, string | number | boolean | null>
>;

// ============== Trigger contribution ==============

/** Data-only manifest descriptor. Executable code lives at `module.exportPath`. */
export interface PluginAutomationTriggerDefinition extends PluginAutomationEditorMetadata {
	readonly id: PluginLocalId;
	readonly module: PluginStaticModuleExport;
}

/** Bounded firing payload the host hands to a trigger module; no Convex context. */
export interface PluginAutomationTriggerInput {
	readonly contactId: string;
	readonly payload: JsonObject;
}

/** Trusted bundled module invoked only after the host reauthorizes the plugin. */
export interface PluginAutomationTriggerModule<Config = unknown> {
	/** Sole unknown-input boundary for the persisted trigger config; must throw on bad shape. */
	parseConfig(raw: unknown): Config;
	/** Decide whether this firing should start the automation. */
	matches(input: PluginAutomationTriggerInput, config: Config): boolean;
	/** Optional trigger-data projection recorded on the run; primitives only. */
	buildTriggerData?(
		input: PluginAutomationTriggerInput,
		config: Config
	): PluginAutomationTriggerData;
}

// ============== Step contribution ==============

export interface PluginAutomationStepDefinition extends PluginAutomationEditorMetadata {
	readonly id: PluginLocalId;
	readonly module: PluginStaticModuleExport;
}

/** Bounded contact snapshot handed to a step module; no ids, tenant, or Convex context. */
export interface PluginAutomationStepInput {
	readonly contactEmail: string;
	readonly contactProperties: Readonly<Record<string, JsonValue>>;
}

/**
 * Typed terminal semantics. A plugin step may complete or fail; the host owns
 * retries, cancellation, and every downstream branch. `failed` is retryable by
 * the host exactly like a thrown error — a plugin cannot force a run to advance.
 */
export type PluginAutomationStepResult =
	| { readonly kind: 'completed' }
	| { readonly kind: 'failed'; readonly reason: string };

export interface PluginAutomationStepModule<Config = unknown> {
	parseConfig(raw: unknown): Config;
	execute(input: PluginAutomationStepInput, config: Config): Promise<PluginAutomationStepResult>;
}

// ============== Condition contribution ==============

export interface PluginAutomationConditionDefinition extends PluginAutomationEditorMetadata {
	readonly id: PluginLocalId;
	readonly module: PluginStaticModuleExport;
}

/** Bounded contact snapshot handed to a condition module for synchronous evaluation. */
export interface PluginAutomationConditionInput {
	readonly contactEmail: string;
	readonly contactProperties: Readonly<Record<string, JsonValue>>;
}

export interface PluginAutomationConditionModule<Config = unknown> {
	parseConfig(raw: unknown): Config;
	evaluate(input: PluginAutomationConditionInput, config: Config): boolean;
}
