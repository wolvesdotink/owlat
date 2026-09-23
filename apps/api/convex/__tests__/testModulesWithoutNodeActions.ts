/**
 * The shared convex-test module map MINUS the action-only modules that pull in
 * Node/LLM dependencies.
 *
 * The glob itself lives next door in `testModules.ts`; this file only
 * SUBTRACTS from it. It lives here rather than inside one domain's `__tests__`
 * folder for the same reason the glob does: more than one suite needs the
 * filtered view (mail and inbox today), and a suite reaching sideways into
 * another domain's test helper couples them for no reason.
 */

import { modules as backendModules } from './testModules';

// No module is named `sesActions` any more; the marker only matched
// `mail/aliasesActions.ts` by accident, so alias-cache actions the mail suites
// schedule could not be found and failed in the background.
const EXCLUDED_MODULE_MARKERS = ['agentSecurity', 'llmProvider'] as const;

export const modules = Object.fromEntries(
	Object.entries(backendModules).filter(
		([path]) => !EXCLUDED_MODULE_MARKERS.some((marker) => path.includes(marker))
	)
);
