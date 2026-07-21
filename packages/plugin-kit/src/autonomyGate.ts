import type { PluginNamespacedKind } from './namespacedKind';
import type { PluginStaticModuleExport } from './sendTransport';

export const PLUGIN_AUTONOMY_GATE_CAPABILITY = 'send:gate' as const;
export const PLUGIN_AUTONOMY_GATE_TIMEOUT_MAX_MS = 30_000;

export type PluginAutonomyGateKind = PluginNamespacedKind;

/** Data-only declaration for a bundled gate on autonomous agent replies. */
export interface PluginAutonomyGateDefinition {
	readonly id: string;
	readonly label: string;
	readonly module: PluginStaticModuleExport;
	/** Host-enforced wall-clock limit. */
	readonly timeoutMs: number;
}

export interface PluginAutonomyGateClassification {
	readonly category: string;
	readonly intent: string;
	readonly sentiment: string;
	readonly priority: string;
}

/** Bounded immutable mail projection; no Convex context, tenant id, or database document. */
export interface PluginAutonomyGateInput {
	readonly from: string;
	readonly to: string;
	readonly subject: string;
	readonly draftBody: string;
	readonly classification?: PluginAutonomyGateClassification;
}

/** Cooperative cancellation only; the gate receives no host capability or credential. */
export interface PluginAutonomyGateServices {
	readonly signal: AbortSignal;
}

/** A gate can raise an objection or explicitly report none. It cannot approve a send. */
export type PluginAutonomyGateResult =
	| { readonly outcome: 'no-objection' }
	| { readonly outcome: 'objection'; readonly reason: string };

export interface PluginAutonomyGateModule {
	evaluate(
		input: PluginAutonomyGateInput,
		services: PluginAutonomyGateServices
	): Promise<PluginAutonomyGateResult>;
}
