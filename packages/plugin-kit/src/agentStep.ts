import type { JsonValue } from './json';
import type { PluginId } from './pluginId';
import type { PluginStaticModuleExport } from './sendTransport';

/** Capability assigned by the host to every bundled agent-pipeline step. */
export const PLUGIN_AGENT_STEP_CAPABILITY = 'agent:step' as const;

export type PluginAgentStepCapability = typeof PLUGIN_AGENT_STEP_CAPABILITY;
export type PluginAgentStepLocalId = string;
export type PluginAgentStepKind = `plugin.${PluginId}.${PluginAgentStepLocalId}`;

/** Finite, host-recognized lifecycle requests a step may make after it runs. */
export type PluginAgentLifecycleEdge =
	| {
			readonly kind: 'caution';
			readonly from: 'classifying' | 'drafting';
			readonly to: 'archived' | 'failed';
	  }
	| {
			readonly kind: 'draft_review';
			readonly from: 'drafting';
			readonly to: 'draft_ready';
	  };

/** Data-only manifest descriptor. Executable code lives at `module.exportPath`. */
export interface PluginAgentStepDefinition {
	readonly id: PluginAgentStepLocalId;
	/** Core or namespaced plugin step after which this contribution runs. */
	readonly after: string;
	readonly module: PluginStaticModuleExport;
	/** Restrict-only edges requested by this step and approved by the host. */
	readonly lifecycleEdges: readonly PluginAgentLifecycleEdge[];
}

/** Bounded message projection supplied by the host; no raw Convex context leaks. */
export interface PluginAgentStepInput {
	readonly inboundMessageId: string;
	readonly from: string;
	readonly to: string;
	readonly subject: string;
	readonly textBody?: string;
	readonly htmlBody?: string;
}

export type PluginAgentStepResult =
	| { readonly kind: 'continue'; readonly output?: JsonValue }
	| {
			readonly kind: 'caution';
			readonly to: 'archived' | 'draft_ready' | 'failed';
			readonly reason: string;
			readonly output?: JsonValue;
	  };

/** Trusted bundled module invoked only after the host reauthorizes it. */
export interface PluginAgentStepModule {
	execute(input: PluginAgentStepInput): Promise<PluginAgentStepResult>;
}

export function pluginAgentStepKind(
	pluginId: PluginId,
	localId: PluginAgentStepLocalId
): PluginAgentStepKind {
	return `plugin.${pluginId}.${localId}`;
}
