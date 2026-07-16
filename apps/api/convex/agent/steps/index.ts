'use node';

/**
 * Agent step (module) registry — see ADR-0014.
 *
 * The single place that knows the kind → module mapping. Adding a new
 * step kind means adding the module, adding the `AgentStepKind` union
 * literal, the lifecycle's `actionType` enum, and one entry here.
 *
 * Node-only because LLM-based modules (`classify`, `clarify`, `draft`)
 * carry `'use node'` themselves.
 */

import { securityScanStep } from './security_scan';
import { contextRetrievalStep } from './context_retrieval';
import { classifyStep } from './classify';
import { clarifyStep } from './clarify';
import { draftStep } from './draft';
import { routeStep } from './route';
import type { PluginAgentStepModule } from '@owlat/plugin-kit';
import { BUNDLED_PLUGIN_AGENT_STEP_MODULES } from '../../plugins/agentStepModules.generated';
import type { CoreAgentStepKind } from './catalog';
import type { AgentStepKind, AnyAgentStepModule } from './types';

export const CORE_STEP_MODULES: Record<CoreAgentStepKind, AnyAgentStepModule> = {
	security_scan: securityScanStep as AnyAgentStepModule,
	context_retrieval: contextRetrievalStep as AnyAgentStepModule,
	classify: classifyStep as AnyAgentStepModule,
	clarify: clarifyStep as AnyAgentStepModule,
	draft: draftStep as AnyAgentStepModule,
	route: routeStep as AnyAgentStepModule,
};

interface HostedPluginAgentStepModule {
	readonly kind: string;
	readonly pluginId: string;
	readonly module: PluginAgentStepModule;
}

const PLUGIN_STEP_MODULES =
	BUNDLED_PLUGIN_AGENT_STEP_MODULES as readonly HostedPluginAgentStepModule[];

export function pluginStepModuleFor(kind: AgentStepKind): PluginAgentStepModule {
	const registration = PLUGIN_STEP_MODULES.find((candidate) => candidate.kind === kind);
	if (!registration) throw new Error(`Unknown hosted plugin agent step: ${kind}`);
	return registration.module;
}

export function stepModuleFor(kind: AgentStepKind): AnyAgentStepModule {
	const module = CORE_STEP_MODULES[kind as CoreAgentStepKind];
	if (!module) {
		throw new Error(`Unknown agent step kind: ${kind}`);
	}
	return module;
}
