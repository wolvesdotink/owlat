import {
	pluginAgentStepKind,
	type PluginAgentLifecycleEdge,
	type PluginId,
} from '@owlat/plugin-kit';
import type { BundledPlugin } from './composition';
import { compareCodePoints } from './compareCodePoints';

export const CORE_AGENT_STEP_DEFINITIONS = [
	{ kind: 'security_scan', continuationStatus: 'classifying', placement: 'classification' },
	{ kind: 'context_retrieval', continuationStatus: 'classifying', placement: 'classification' },
	{ kind: 'classify', continuationStatus: 'classifying', placement: 'classification' },
	{ kind: 'clarify', continuationStatus: 'drafting', placement: 'before_draft' },
	{ kind: 'draft', continuationStatus: 'drafting', placement: 'after_draft' },
	{ kind: 'route', continuationStatus: undefined, placement: undefined },
] as const;

export type CoreAgentStepKind = (typeof CORE_AGENT_STEP_DEFINITIONS)[number]['kind'];

export type AgentStepPlacement = 'classification' | 'before_draft' | 'after_draft';

export interface HostedAgentStepDefinition {
	readonly pluginId: PluginId;
	readonly packageName: string;
	readonly kind: string;
	readonly after: string;
	readonly exportPath: string;
	readonly lifecycleEdges: readonly PluginAgentLifecycleEdge[];
	readonly continuationStatus: string;
	readonly placement: AgentStepPlacement;
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
	'continuationStatus' | 'placement'
> {}

interface LifecycleEdgeTuple {
	readonly kind: string;
	readonly from: string;
	readonly to: string;
}

const CAUTION_TARGETS = ['archived', 'failed'] as const;

const SAFE_LIFECYCLE_EDGES_BY_PLACEMENT: Readonly<
	Record<AgentStepPlacement, readonly LifecycleEdgeTuple[]>
> = Object.freeze({
	classification: Object.freeze(
		CAUTION_TARGETS.map((to) => Object.freeze({ kind: 'caution', from: 'classifying', to }))
	),
	before_draft: Object.freeze(
		CAUTION_TARGETS.map((to) => Object.freeze({ kind: 'caution', from: 'drafting', to }))
	),
	after_draft: Object.freeze([
		...CAUTION_TARGETS.map((to) => Object.freeze({ kind: 'caution', from: 'drafting', to })),
		Object.freeze({ kind: 'draft_review', from: 'drafting', to: 'draft_ready' }),
	]),
});

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
		let placement: AgentStepPlacement | undefined = coreAnchor?.placement;
		if (!coreAnchor) {
			const pluginAnchor = definitionsByKind.get(definition.after);
			if (!pluginAnchor) {
				throw new AgentStepCompositionError(
					'unknown_step_anchor',
					kind,
					`Agent step ${kind} follows unknown step ${definition.after}`
				);
			}
			const resolvedAnchor = resolve(pluginAnchor.kind);
			continuationStatus = resolvedAnchor.continuationStatus;
			placement = resolvedAnchor.placement;
		}
		if (!continuationStatus || !placement) {
			throw new AgentStepCompositionError(
				'terminal_step_anchor',
				kind,
				`Agent step ${kind} cannot follow terminal step ${definition.after}`
			);
		}
		validateEdges(definition, placement);
		resolving.delete(kind);
		const result = Object.freeze({ ...definition, continuationStatus, placement });
		resolved.set(kind, result);
		return result;
	};

	const ordered = [...definitionsByKind.keys()].sort(compareCodePoints).map(resolve);
	return Object.freeze(ordered);
}

function validateEdges(
	definition: UnresolvedAgentStepDefinition,
	placement: AgentStepPlacement
): void {
	if (!Array.isArray(definition.lifecycleEdges)) {
		throwUnsafeLifecycleEdge(definition.kind, undefined);
	}
	for (const edge of definition.lifecycleEdges) {
		if (!isSafeAgentLifecycleEdge(placement, edge)) {
			throwUnsafeLifecycleEdge(definition.kind, readLifecycleEdgeTuple(edge));
		}
	}
}

function readLifecycleEdgeTuple(value: unknown): LifecycleEdgeTuple | undefined {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const kind = ownStringField(value, 'kind');
	const from = ownStringField(value, 'from');
	const to = ownStringField(value, 'to');
	if (kind === undefined || from === undefined || to === undefined) return undefined;
	return { kind, from, to };
}

function ownStringField(value: object, field: keyof LifecycleEdgeTuple): string | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(value, field);
	return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
		? descriptor.value
		: undefined;
}

/** Runtime-check a complete edge tuple against the host-owned placement policy. */
export function isSafeAgentLifecycleEdge(
	placement: AgentStepPlacement,
	edge: unknown
): edge is PluginAgentLifecycleEdge {
	const tuple = readLifecycleEdgeTuple(edge);
	if (!tuple) return false;
	return SAFE_LIFECYCLE_EDGES_BY_PLACEMENT[placement].some(
		(allowed) =>
			allowed.kind === tuple.kind && allowed.from === tuple.from && allowed.to === tuple.to
	);
}

function throwUnsafeLifecycleEdge(stepKind: string, edge: LifecycleEdgeTuple | undefined): never {
	const description = edge ? `${edge.kind}:${edge.from}->${edge.to}` : 'malformed edge';
	throw new AgentStepCompositionError(
		'unsafe_lifecycle_edge',
		stepKind,
		`Agent step ${stepKind} declares unsafe lifecycle edge ${description}`
	);
}
