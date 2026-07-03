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
import type { AgentStepKind, AnyAgentStepModule } from './types';

export const STEP_MODULES: Record<AgentStepKind, AnyAgentStepModule> = {
	security_scan: securityScanStep as AnyAgentStepModule,
	context_retrieval: contextRetrievalStep as AnyAgentStepModule,
	classify: classifyStep as AnyAgentStepModule,
	clarify: clarifyStep as AnyAgentStepModule,
	draft: draftStep as AnyAgentStepModule,
	route: routeStep as AnyAgentStepModule,
};

export function stepModuleFor(kind: AgentStepKind): AnyAgentStepModule {
	const module = STEP_MODULES[kind];
	if (!module) {
		throw new Error(`Unknown agent step kind: ${kind}`);
	}
	return module;
}
