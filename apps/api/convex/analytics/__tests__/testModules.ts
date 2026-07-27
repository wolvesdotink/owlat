/**
 * Shared convex-test module map for the `analytics/__tests__` suite.
 *
 * `convexTest(schema, modules)` needs a glob of every backend module, but Vite's
 * `import.meta.glob` excludes the directory chain it climbed up through: a single
 * `../../**` glob rooted here (`analytics/__tests__/`) omits the `analytics/` dir
 * it passed on the way up. So we merge a second glob rooted at `analytics/` and
 * re-prefix its keys. Same shape as `delivery/__tests__/testModules.ts`.
 */

const rootGlob = import.meta.glob('../../**/*.*s');
const analyticsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../analytics/'),
		module,
	])
);

export const modules = { ...rootGlob, ...analyticsGlob };
