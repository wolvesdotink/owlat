import type { PluginLlmService } from './context';
import type { PluginId } from './pluginId';
import type { PluginStaticModuleExport } from './sendTransport';

export const PLUGIN_DRAFT_STRATEGY_CAPABILITY = 'draft:strategy' as const;
export const PLUGIN_DRAFT_STRATEGY_TIMEOUT_MAX_MS = 30_000;

export type PluginDraftStrategyKind = `plugin.${PluginId}.${string}`;

/** Data-only bundled-strategy declaration. */
export interface PluginDraftStrategyDefinition {
	readonly id: string;
	readonly label: string;
	readonly module: PluginStaticModuleExport;
	/** Host-enforced wall-clock limit. */
	readonly timeoutMs: number;
}

export interface PluginDraftClassification {
	readonly category: string;
	readonly intent: string;
	readonly sentiment: string;
	readonly priority: string;
}

/** Bounded snapshot; plugins never receive Convex contexts, ids, or tenant metadata. */
export interface PluginDraftStrategyInput {
	readonly audience: 'organization' | 'personal';
	readonly context: string;
	readonly confirmedContext?: string;
	readonly stanceGuidance?: string;
	readonly classification: PluginDraftClassification;
	readonly toneInstruction: string;
	readonly signatureInstruction: string;
	readonly voiceSection: string;
}

export interface PluginDraftStrategyServices {
	/** Attributed, authorized, budgeted host dispatch; no provider credentials leak. */
	readonly llm: PluginLlmService;
}

export interface PluginDraftStrategyResult {
	readonly draftBody: string;
}

export interface PluginDraftStrategyModule {
	generate(
		input: PluginDraftStrategyInput,
		services: PluginDraftStrategyServices
	): Promise<PluginDraftStrategyResult>;
}

export function pluginDraftStrategyKind(
	pluginId: PluginId,
	localId: string
): PluginDraftStrategyKind {
	return `plugin.${pluginId}.${localId}`;
}
