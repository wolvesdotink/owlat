/**
 * Shared convex-test module map for the `analytics/__tests__` suite.
 *
 * `convexTest(schema, modules)` needs a glob of every backend module, but Vite's
 * `import.meta.glob` excludes the directory chain it climbed up through: a
 * single `'../../**'` glob rooted here (`analytics/__tests__/`) omits the
 * `analytics/` directory it passed on the way up, so every
 * `t.query(internal.analytics.*)` in this suite would fail with
 * `Could not find module for: "analytics/…"`. Merge a second glob rooted at
 * `analytics/` and re-prefix its keys to the same `../../`-relative form so
 * convex-test resolves every entry.
 *
 * Mirrors `mail/__tests__/testModules.ts`; extracted here so the seed-placement
 * suites share one map instead of accreting a fourth hand-copied merge.
 */

const rootGlob = import.meta.glob('../../**/*.*s');
const analyticsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../analytics/'),
		mod,
	])
);

export const modules = { ...rootGlob, ...analyticsGlob };
