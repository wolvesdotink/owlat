/**
 * The mail suite's view of the shared convex-test module map.
 *
 * The map itself lives at `convex/__tests__/testModules.ts`; this file only
 * SUBTRACTS from it. Mail tests cannot load the action-only modules that pull
 * in Node/LLM dependencies, so those three are filtered out — a filter is a
 * property of this suite, while the glob is not, which is why only the filter
 * lives here.
 */

import { modules as backendModules } from '../../__tests__/testModules';

const EXCLUDED_MODULE_MARKERS = ['sesActions', 'agentSecurity', 'llmProvider'] as const;

export const modules = Object.fromEntries(
	Object.entries(backendModules).filter(
		([path]) => !EXCLUDED_MODULE_MARKERS.some((marker) => path.includes(marker))
	)
);
