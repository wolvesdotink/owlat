import { arrayOf, decodeJson, JsonShapeError, object, recordOf, string } from '../json';
export interface Task {
	task: string;
	package: string;
	directory: string;
	command?: string;
}
export interface Workspace {
	package: string;
	name: string;
	directory: string;
}
export function coverageWorkspaces(tasks: Task[]): Workspace[] {
	const unique = new Map<string, Workspace>();
	for (const task of tasks) {
		if (task.task !== 'test:coverage' || !task.command || task.command === '<NONEXISTENT>')
			continue;
		if (!/^@owlat\/[a-z0-9-]+$/.test(task.package)) throw new Error('Invalid CI workspace');
		unique.set(task.package, {
			package: task.package,
			name: task.package.slice(7),
			directory: task.directory,
		});
	}
	return [...unique.values()].sort((a, b) => a.package.localeCompare(b.package));
}
// Duration weights balance small suites; heavy suites have dedicated jobs.
const weights: Record<string, number> = { 'email-builder': 4, shared: 3, docs: 3, 'plugin-kit': 2 };
export function groupWorkspaces(workspaces: Workspace[], count = 4) {
	const small = workspaces.filter((w) => !['api', 'web', 'mta', 'desktop'].includes(w.name));
	const bins = Array.from({ length: Math.min(count, small.length) }, (_, id) => ({
		id: id + 1,
		workspaces: [] as Workspace[],
		weight: 0,
	}));
	for (const workspace of [...small].sort(
		(a, b) => (weights[b.name] ?? 1) - (weights[a.name] ?? 1)
	)) {
		const bin = [...bins].sort((a, b) => a.weight - b.weight || a.id - b.id)[0]!;
		bin.workspaces.push(workspace);
		bin.weight += weights[workspace.name] ?? 1;
	}
	return bins.map(({ id, workspaces: items }) => ({ id, workspaces: items }));
}
/**
 * Files the desktop SPA (`generate:desktop`) is built from beyond the web
 * workspace's own package graph: the bridge the web app imports by path (it is
 * not a declared dependency, so turbo does not see it), the Tauri config that
 * names the dist, and the inspector itself.
 */
const DESKTOP_SPA_INPUTS = [
	'apps/desktop/src/',
	'apps/desktop/package.json',
	'apps/desktop/src-tauri/tauri.conf.json',
	'scripts/check-desktop-spa.ts',
];
export function desktopSpaSelected(full: boolean, web: boolean, changed: string[]): boolean {
	return (
		full ||
		web ||
		changed.some((file) =>
			DESKTOP_SPA_INPUTS.some((input) =>
				input.endsWith('/') ? file.startsWith(input) : file === input
			)
		)
	);
}
/**
 * Paths the Java SDK's Maven suite reads. It lives outside the bun workspace,
 * so turbo cannot see that its contract tests read the generated OpenAPI
 * document from packages/public-contract; a contract-only change must still
 * run them.
 */
const JAVA_SDK_INPUTS = ['packages/sdk-java/', 'packages/public-contract/'];

export interface DockerImage {
	name: string;
	package: string;
	dockerfile: string;
}
export interface CiSelection<Image extends DockerImage = DockerImage> {
	groups: ReturnType<typeof groupWorkspaces>;
	api: boolean;
	web: boolean;
	mta: boolean;
	images: Image[];
	java: boolean;
	desktopSpa: boolean;
}
/**
 * The pull-request work CI selects: the detect job (scripts/ci/select.ts) and
 * `bun run check:changed` both call this, so the local summary of what CI
 * still runs cannot drift from the matrix CI builds.
 */
export function selectCiWork<Image extends DockerImage>(input: {
	full: boolean;
	changed: string[];
	coverage: Workspace[];
	affected: string[];
	images: Image[];
}): CiSelection<Image> {
	const { full, changed, coverage, affected, images } = input;
	const web = coverage.some((w) => w.name === 'web');
	return {
		groups: groupWorkspaces(coverage),
		api: coverage.some((w) => w.name === 'api'),
		web,
		mta: coverage.some((w) => w.name === 'mta'),
		images:
			full || changed.includes('.github/docker-images.json')
				? images
				: images.filter(
						(image) => affected.includes(image.package) || changed.includes(image.dockerfile)
					),
		java: full || changed.some((file) => JAVA_SDK_INPUTS.some((input) => file.startsWith(input))),
		desktopSpa: desktopSpaSelected(full, web, changed),
	};
}
export function expectedJobs(selection: {
	groups: unknown[];
	api: boolean;
	web: boolean;
	mta: boolean;
	images: unknown[];
	java: boolean;
	desktopSpa: boolean;
}): string[] {
	return [
		'detect',
		'lint',
		'typecheck',
		'ramp-gate-matrix',
		...(selection.groups.length ? ['test'] : []),
		...(selection.api ? ['test-api', 'test-api-merge'] : []),
		...(selection.web ? ['test-web', 'test-web-merge', 'test-web-browser'] : []),
		...(selection.mta ? ['test-mta'] : []),
		...(selection.images.length ? ['docker-build'] : []),
		...(selection.java ? ['sdk-java'] : []),
		...(selection.desktopSpa ? ['desktop-spa'] : []),
	];
}
const decodeGroup = object({
	workspaces: arrayOf(object({ package: string, name: string, directory: string })),
});
/** A test group as the detect job wrote it into the matrix (`CI_GROUP`). */
export function parseTestGroup(text: string | undefined): { workspaces: Workspace[] } {
	if (!text) throw new JsonShapeError('Missing CI test group');
	return decodeJson(text, decodeGroup, 'CI_GROUP');
}
/** The job names the detect job expects to run (`CI_EXPECTED`). */
export function parseExpectedJobs(text: string | undefined): string[] {
	if (!text) throw new JsonShapeError('Missing expected CI job manifest');
	return decodeJson(text, arrayOf(string), 'CI_EXPECTED');
}
/** The `needs` context of the summary job (`CI_NEEDS`): each job's result. */
export function parseJobResults(text: string | undefined): Record<string, { result: string }> {
	return decodeJson(text ?? '{}', recordOf(object({ result: string })), 'CI_NEEDS');
}
export function assertJobResults(expected: string[], needs: Record<string, { result: string }>) {
	if (!expected.includes('detect') || new Set(expected).size !== expected.length)
		throw new Error('Invalid expected CI job manifest');
	for (const job of expected)
		if (needs[job]?.result !== 'success') throw new Error(`Selected CI job ${job} did not succeed`);
	for (const [job, outcome] of Object.entries(needs))
		if (!expected.includes(job) && outcome.result !== 'skipped')
			throw new Error(`Unexpected CI job ${job}: ${outcome.result}`);
}

// ---- Local selection for `bun run check:changed` ---------------------------

/**
 * A repo-relative path pattern: a trailing `/` matches everything under that
 * directory, `**` any number of directories, `*` and `?` within one path
 * segment, `{a,b}` either alternative; anything else is an exact path.
 */
export function pathPattern(pattern: string): RegExp {
	return new RegExp(`^${globSource(pattern)}${pattern.endsWith('/') ? '' : '$'}`);
}
function globSource(pattern: string): string {
	let source = '';
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index]!;
		if (pattern.startsWith('**/', index)) {
			source += '(?:.*/)?';
			index += 2;
		} else if (pattern.startsWith('**', index)) {
			source += '.*';
			index += 1;
		} else if (char === '*') source += '[^/]*';
		else if (char === '?') source += '[^/]';
		else if (char === '{') source += '(?:';
		else if (char === '}') source += ')';
		else if (char === ',' && openBraces(pattern, index)) source += '|';
		else source += escapeRegExp(char);
	}
	return source;
}
function openBraces(pattern: string, index: number): boolean {
	const before = pattern.slice(0, index);
	return before.split('{').length > before.split('}').length;
}
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
export function matchesAny(file: string, patterns: readonly string[]): boolean {
	return patterns.some((pattern) => pathPattern(pattern).test(file));
}
/** A gate runs when a changed path matches its inputs or a workspace it reads is affected. */
export function gateSelected(
	inputs: { readonly paths: readonly string[]; readonly packages?: readonly string[] },
	changed: readonly string[],
	affected: ReadonlySet<string>,
	globalInputs: readonly string[] = []
): boolean {
	const patterns = [...globalInputs, ...inputs.paths];
	return (
		changed.some((file) => matchesAny(file, patterns)) ||
		(inputs.packages ?? []).some((name) => affected.has(name))
	);
}

/**
 * turbo.json `inputs` that live outside a package (`$TURBO_ROOT$/...`), per
 * task. `turbo --affected` only maps a change to the package whose directory
 * holds it, so a lint task that reads other packages' files (the api lint's
 * caller scan, the setup-cli env-key sync) or a generic task input under the
 * repo root is not selected by it; these patterns close that gap. Negated
 * entries only drop generated output, which never shows up as a change, so
 * ignoring them can only widen the selection.
 */
export interface TurboTaskConfig {
	inputs?: string[];
}
export function rootTaskInputs(
	tasks: Record<string, TurboTaskConfig>,
	task: string
): { all: string[]; byPackage: Map<string, string[]> } {
	const rooted = (inputs: string[] | undefined) =>
		(inputs ?? [])
			.filter((input) => input.startsWith('$TURBO_ROOT$/'))
			.map((input) => input.slice('$TURBO_ROOT$/'.length));
	const byPackage = new Map<string, string[]>();
	for (const [key, config] of Object.entries(tasks)) {
		const [name, taskName] = key.includes('#') ? key.split('#') : [undefined, key];
		if (taskName !== task || !name || name === '/' || name === '//') continue;
		const patterns = rooted(config.inputs);
		if (patterns.length) byPackage.set(name, patterns);
	}
	return { all: rooted(tasks[task]?.inputs), byPackage };
}
/** Workspaces whose `task` reads a changed path outside their own directory. */
export function rootInputSelection(
	tasks: Record<string, TurboTaskConfig>,
	task: string,
	changed: readonly string[],
	workspaces: readonly string[]
): string[] {
	const { all, byPackage } = rootTaskInputs(tasks, task);
	const hit = (patterns: string[]) => changed.some((file) => matchesAny(file, patterns));
	if (all.length && hit(all)) return [...workspaces];
	return workspaces.filter((name) => hit(byPackage.get(name) ?? []));
}

export interface Change {
	path: string;
	deleted: boolean;
}
export interface TestWorkspace extends Workspace {
	/** `vitest related` follows the import graph; false for suites where that graph is the whole backend. */
	related: boolean;
}
export type TestPlan =
	| { workspace: TestWorkspace; mode: 'full'; reason: string }
	| { workspace: TestWorkspace; mode: 'related'; files: string[] }
	| { workspace: TestWorkspace; mode: 'files'; files: string[] };

/**
 * A change to one of these can change any test result in any workspace. The
 * root package.json is not listed: its catalog and overrides only reach a test
 * through the lockfile, and its scripts reach none.
 */
export const ROOT_TEST_INPUTS = [
	'bun.lock',
	'tsconfig.base.json',
	'vitest.shared.ts',
	'vitest.timeouts.ts',
];
/** Relative to a workspace: its manifest, test config and setup files. */
const WORKSPACE_TEST_CONFIG = [
	'package.json',
	'vitest.*',
	'vite.config.*',
	'tsconfig*.json',
	'**/vitest.setup.*',
	'**/__tests__/setup.*',
];
export const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const SOURCE_FILE = /\.([cm]?[jt]sx?|vue)$/;

/**
 * Which tests to run per selected workspace. A change `vitest related` cannot
 * follow (a deleted file, the workspace's own test config or manifest, a root
 * test input) runs the whole suite instead of quietly selecting nothing. A
 * workspace without `related` gets its changed test files and the test files
 * named after its changed sources (`x.ts` → `x.test.ts`, `x.integration.test.ts`
 * beside it or in an enclosing `__tests__/`).
 */
export function planTests(
	workspaces: readonly TestWorkspace[],
	changes: readonly Change[],
	listDirectory: (directory: string) => string[]
): TestPlan[] {
	const present = changes.filter((change) => !change.deleted).map((change) => change.path);
	const rootChange = changes.find((change) => ROOT_TEST_INPUTS.includes(change.path));
	return workspaces.map((workspace): TestPlan => {
		const prefix = `${workspace.directory}/`;
		const own = changes.filter((change) => change.path.startsWith(prefix));
		const config = own.find((change) =>
			matchesAny(change.path.slice(prefix.length), WORKSPACE_TEST_CONFIG)
		);
		const deleted = own.find((change) => change.deleted);
		const reason = rootChange
			? `${rootChange.path} changed`
			: config
				? `${config.path} changed`
				: deleted
					? `${deleted.path} was deleted`
					: undefined;
		if (reason) return { workspace, mode: 'full', reason };
		if (workspace.related) return { workspace, mode: 'related', files: present };
		const tests = new Set<string>();
		for (const file of present) {
			if (!file.startsWith(prefix) || !SOURCE_FILE.test(file)) continue;
			if (TEST_FILE.test(file)) {
				tests.add(file);
				continue;
			}
			const name = file.slice(file.lastIndexOf('/') + 1);
			const stem = `${name.slice(0, name.lastIndexOf('.'))}.`;
			for (const directory of neighbourDirectories(file, workspace.directory))
				for (const entry of listDirectory(directory))
					if (entry.startsWith(stem) && TEST_FILE.test(entry)) tests.add(`${directory}/${entry}`);
		}
		return { workspace, mode: 'files', files: [...tests].sort() };
	});
}
/** The file's directory, then every enclosing `__tests__/` up to the workspace root. */
function neighbourDirectories(file: string, root: string): string[] {
	const directories: string[] = [];
	let directory = file.slice(0, file.lastIndexOf('/'));
	directories.push(directory);
	while (directory.length >= root.length) {
		if (!directory.endsWith('/__tests__')) directories.push(`${directory}/__tests__`);
		if (directory === root) break;
		directory = directory.slice(0, directory.lastIndexOf('/'));
	}
	return directories;
}
