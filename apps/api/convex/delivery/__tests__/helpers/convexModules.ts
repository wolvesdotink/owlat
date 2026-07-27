/**
 * Shared convex-test module map for the `delivery/__tests__` suite.
 *
 * `convexTest(schema, modules)` needs a glob of every backend module, but Vite's
 * `import.meta.glob` excludes the directory chain it climbed up through: a
 * single glob rooted here omits the `delivery/` directory it passed on the way
 * up. So we merge a second glob rooted at `delivery/` and re-prefix its keys.
 * Previously copy-pasted verbatim into every SNDS suite; extracted here so the
 * next test imports it instead of accreting a fifth copy.
 */

const rootGlob = import.meta.glob('../../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\/\.\.\//, '../../../delivery/'),
		module,
	])
);

export const modules = { ...rootGlob, ...deliveryGlob };
