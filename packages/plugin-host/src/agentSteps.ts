import {
	pluginAgentStepKind,
	type PluginAgentLifecycleEdge,
	type PluginId,
} from '@owlat/plugin-kit';
import type { BundledPlugin } from './composition';
import { compareCodePoints } from './compareCodePoints';

export const CORE_AGENT_STEP_DEFINITIONS = [
	{ kind: 'security_scan', continuationStatus: 'classifying' },
	{ kind: 'context_retrieval', continuationStatus: 'classifying' },
	{ kind: 'classify', continuationStatus: 'classifying' },
	{ kind: 'clarify', continuationStatus: 'drafting' },
	{ kind: 'draft', continuationStatus: 'drafting' },
	{ kind: 'route', continuationStatus: undefined },
] as const;

export type CoreAgentStepKind = (typeof CORE_AGENT_STEP_DEFINITIONS)[number]['kind'];

const SAFE_CAUTION_TARGETS = Object.freeze({
	classifying: Object.freeze(['archived', 'failed']),
	drafting: Object.freeze(['archived', 'draft_ready', 'failed']),
});

export interface HostedAgentStepDefinition {
	readonly pluginId: PluginId;
	readonly packageName: string;
	readonly kind: string;
	readonly after: string;
	readonly exportPath: string;
	readonly lifecycleEdges: readonly PluginAgentLifecycleEdge[];
	readonly continuationStatus: string;
}

export type AgentStepCompositionErrorCode =
	| 'duplicate_step_kind'
	| 'unknown_step_anchor'
	| 'cyclic_step_order'
	| 'terminal_step_anchor'
	| 'unsafe_lifecycle_edge';

export class AgentStepCompositionError extends Error {
	readonly code: AgentStepCompositionErrorCode;
	readonly stepKind: string;

	constructor(code: AgentStepCompositionErrorCode, stepKind: string, message: string) {
		super(message);
		this.name = 'AgentStepCompositionError';
		this.code = code;
		this.stepKind = stepKind;
	}
}

interface UnresolvedAgentStepDefinition extends Omit<
	HostedAgentStepDefinition,
	'continuationStatus'
> {}

/** Flatten manifest declarations and validate them against the host-owned pipeline policy. */
export function composeBundledAgentSteps(
	plugins: readonly BundledPlugin[]
): readonly HostedAgentStepDefinition[] {
	const definitions = plugins.flatMap((plugin) =>
		(plugin.manifest.contributes?.agentSteps ?? []).map((step) => ({
			pluginId: plugin.manifest.id,
			packageName: plugin.packageName,
			kind: pluginAgentStepKind(plugin.manifest.id, step.id),
			after: step.after,
			exportPath: step.module.exportPath,
			lifecycleEdges: step.lifecycleEdges,
		}))
	);
	return composeAgentStepDefinitions(definitions);
}

/** Validate identity, insertion order, cycles, and every requested caution edge. */
export function composeAgentStepDefinitions(
	definitions: readonly UnresolvedAgentStepDefinition[]
): readonly HostedAgentStepDefinition[] {
	const coreByKind = new Map(
		CORE_AGENT_STEP_DEFINITIONS.map((definition) => [definition.kind, definition] as const)
	);
	const definitionsByKind = new Map<string, UnresolvedAgentStepDefinition>();
	for (const definition of definitions) {
		if (
			definitionsByKind.has(definition.kind) ||
			coreByKind.has(definition.kind as CoreAgentStepKind)
		) {
			throw new AgentStepCompositionError(
				'duplicate_step_kind',
				definition.kind,
				`Agent step kind ${definition.kind} is declared more than once`
			);
		}
		definitionsByKind.set(definition.kind, definition);
	}

	const resolving = new Set<string>();
	const resolved = new Map<string, HostedAgentStepDefinition>();
	const resolve = (kind: string): HostedAgentStepDefinition => {
		const cached = resolved.get(kind);
		if (cached) return cached;
		const definition = definitionsByKind.get(kind);
		if (!definition) {
			throw new AgentStepCompositionError(
				'unknown_step_anchor',
				kind,
				`Agent step anchor ${kind} is not registered`
			);
		}
		if (resolving.has(kind)) {
			throw new AgentStepCompositionError(
				'cyclic_step_order',
				kind,
				`Agent step insertion graph contains a cycle at ${kind}`
			);
		}
		resolving.add(kind);
		const coreAnchor = coreByKind.get(definition.after as CoreAgentStepKind);
		let continuationStatus: string | undefined = coreAnchor?.continuationStatus;
		if (!coreAnchor) {
			const pluginAnchor = definitionsByKind.get(definition.after);
			if (!pluginAnchor) {
				throw new AgentStepCompositionError(
					'unknown_step_anchor',
					kind,
					`Agent step ${kind} follows unknown step ${definition.after}`
				);
			}
			continuationStatus = resolve(pluginAnchor.kind).continuationStatus;
		}
		if (!continuationStatus) {
			throw new AgentStepCompositionError(
				'terminal_step_anchor',
				kind,
				`Agent step ${kind} cannot follow terminal step ${definition.after}`
			);
		}
		validateEdges(definition, continuationStatus);
		resolving.delete(kind);
		const result = Object.freeze({ ...definition, continuationStatus });
		resolved.set(kind, result);
		return result;
	};

	const ordered = [...definitionsByKind.keys()].sort(compareCodePoints).map(resolve);
	return Object.freeze(ordered);
}

function validateEdges(definition: UnresolvedAgentStepDefinition, status: string): void {
	const safeTargets = SAFE_CAUTION_TARGETS[status as keyof typeof SAFE_CAUTION_TARGETS] as
		| readonly string[]
		| undefined;
	for (const edge of definition.lifecycleEdges) {
		if (edge.from !== status || !safeTargets?.includes(edge.to)) {
			throw new AgentStepCompositionError(
				'unsafe_lifecycle_edge',
				definition.kind,
				`Agent step ${definition.kind} declares unsafe lifecycle edge ${edge.from}->${edge.to}`
			);
		}
	}
}
