/**
 * Shared convex-test module map for the `mail/__tests__` suite.
 *
 * `convexTest(schema, modules)` needs a glob of every backend module, but Vite's
 * `import.meta.glob` excludes the directory chain it climbed up through: a single
 * `../../**` glob rooted here (`mail/__tests__/`) omits the `mail/` dir it passed
 * on the way up. So we merge a second glob rooted at `mail/` and re-prefix its
 * keys, then drop the action-only modules that pull in Node/LLM deps a unit test
 * cannot (and need not) load. Previously copy-pasted into every mail test file;
 * extracted here so the next test reuses it instead of accreting a fourth copy.
 */

const rootGlob = import.meta.glob('../../**/*.*s');
const mailGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../mail/'),
		mod,
	])
);
const allModules = { ...rootGlob, ...mailGlob };

export const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('llmProvider')
	)
);
