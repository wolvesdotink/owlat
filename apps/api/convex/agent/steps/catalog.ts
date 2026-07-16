import { v } from 'convex/values';
import { CORE_AGENT_STEP_DEFINITIONS, type CoreAgentStepKind } from '@owlat/plugin-host';
import { BUNDLED_PLUGIN_AGENT_STEP_CATALOG } from '../../plugins/agentStepCatalog.generated';

export { CORE_AGENT_STEP_DEFINITIONS } from '@owlat/plugin-host';
export type { CoreAgentStepKind } from '@owlat/plugin-host';

type GeneratedPluginAgentStepKind =
	(typeof BUNDLED_PLUGIN_AGENT_STEP_CATALOG)[number] extends infer Entry
		? Entry extends { readonly kind: infer Kind extends string }
			? Kind
			: never
		: never;

interface GeneratedPluginAgentStepDefinition {
	readonly kind: string;
	readonly pluginId: string;
	readonly after: string;
	readonly continuationStatus: string;
	readonly lifecycleEdges: readonly Readonly<{ from: string; to: string }>[];
	readonly requiredCapability: 'agent:step';
}

const PLUGIN_AGENT_STEP_CATALOG =
	BUNDLED_PLUGIN_AGENT_STEP_CATALOG as readonly GeneratedPluginAgentStepDefinition[];

export type AgentStepKind = CoreAgentStepKind | GeneratedPluginAgentStepKind;

export const AGENT_STEP_KINDS = Object.freeze([
	...CORE_AGENT_STEP_DEFINITIONS.map((definition) => definition.kind),
	...PLUGIN_AGENT_STEP_CATALOG.map((definition) => definition.kind as GeneratedPluginAgentStepKind),
]) as readonly AgentStepKind[];

export const agentStepKindValidator = v.union(...AGENT_STEP_KINDS.map((kind) => v.literal(kind)));

export function isPluginAgentStepKind(kind: AgentStepKind): kind is GeneratedPluginAgentStepKind {
	return kind.startsWith('plugin.');
}

export function pluginAgentStepDefinition(
	kind: string
): GeneratedPluginAgentStepDefinition | undefined {
	return PLUGIN_AGENT_STEP_CATALOG.find((definition) => definition.kind === kind);
}

/** Depth-first stable expansion keeps siblings and plugin chains deterministic. */
export function pluginStepsFollowing(kind: AgentStepKind): readonly GeneratedPluginAgentStepKind[] {
	const ordered: GeneratedPluginAgentStepKind[] = [];
	const visit = (anchor: string): void => {
		for (const definition of PLUGIN_AGENT_STEP_CATALOG) {
			if (definition.after !== anchor) continue;
			ordered.push(definition.kind as GeneratedPluginAgentStepKind);
			visit(definition.kind);
		}
	};
	visit(kind);
	return Object.freeze(ordered);
}
