/**
 * THE shared convex-test module map.
 *
 * `convexTest(schema, modules)` needs a glob of every backend module. Vite's
 * `import.meta.glob` excludes the directory the calling file lives in, so a map
 * built from a DOMAIN's `__tests__` folder has to merge a second glob to recover
 * that domain's own modules — which is how the same preamble ended up copied
 * into several suites. Rooted here, at `convex/__tests__/`, the single
 * `../**` glob covers the whole backend and excludes only this folder, which
 * holds tests and fixtures rather than modules under test.
 *
 * Live here rather than inside one domain's suite: a suite reaching four
 * directories sideways into another domain's test helper couples them for no
 * reason, and this map is not a property of any one domain.
 */

import { convexTest, type TestConvex } from 'convex-test';
import schema from '../schema';
import betterAuthSchema from '../betterAuth/schema';

export const modules = import.meta.glob('../**/*.*s');
export const betterAuthModules = import.meta.glob('../betterAuth/**/*.*s');

/** A convex-test harness over the whole backend. */
export function newHarness(): TestConvex<typeof schema> {
	return convexTest(schema, modules);
}

/**
 * The same harness with the BetterAuth component registered, for suites that
 * drive the adapter (organizations, members, sessions). A suite that has to
 * trim the module map (the AI modules pull in providers vitest cannot load)
 * passes its own.
 */
export function newBetterAuthHarness(moduleMap = modules): TestConvex<typeof schema> {
	const t = convexTest(schema, moduleMap);
	t.registerComponent('betterAuth', betterAuthSchema, betterAuthModules);
	return t;
}
