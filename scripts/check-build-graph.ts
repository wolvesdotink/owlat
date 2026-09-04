/**
 * Guards the shared provider/plugin contract build artifacts in this monorepo.
 *
 * `@owlat/plugin-kit`'s build is `tsup --clean`, so it wipes and re-emits `dist/`
 * (index.js lands in ~150ms, index.d.ts 2-3s later). Anything reading that
 * directory while the rebuild runs sees a missing or half-written declaration
 * file. The only defence is ordering: the artifact must have a single producer
 * inside turbo's graph, and every consumer task must be a graph descendant of it.
 *
 * Three rules, each of which failed before it was written down:
 *
 *  1. No workspace package script may run a build in another workspace package.
 *     `@owlat/plugin-codegen` and `@owlat/plugin-cli` used to prefix `test` with
 *     `bun run --cwd ../plugin-kit build`, an unordered writer turbo could not
 *     see, which raced `@owlat/code-worker#typecheck` and `@owlat/api#typecheck`.
 *
 *     The ROOT manifest is deliberately in scope for this rule, but with an
 *     allowlist rather than a blanket exemption: `plugins:prepare` is the
 *     sanctioned producer entry point (it is what `//#plugins:check` runs, and
 *     every turbo `build` depends on `//#plugins:check`, so its write completes
 *     before any reader starts), and two further root scripts drive unrelated
 *     packages. Anything else at the root — including a new script wired into a
 *     turbo task — is an unordered writer and fails here. See ROOT_CWD_ALLOWLIST.
 *
 *  2. Every task that can read a guarded package's `dist` must reach that
 *     package's build through turbo's dependency graph.
 *
 *  3. Inside the producing package itself, only the sanctioned scripts may drive
 *     the `tsup --clean`. `test:package` used to be `bun run build && bun
 *     scripts/packageSmoke.ts`, and the smoke's `bun pm pack` re-triggered the
 *     build a second time through `prepack` — a shared-artifact wipe fired from
 *     a *test* task, which turbo runs concurrently with every sibling
 *     `test:coverage` that imports @owlat/plugin-kit. `build` (the producer) and
 *     the publish-only `prepack`/`postpack` hooks are the only exceptions; note
 *     that packing must pass `--ignore-scripts` so it does not reach `prepack`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackageManifest {
	readonly name?: string;
	readonly scripts?: Readonly<Record<string, string>>;
	readonly dependencies?: Readonly<Record<string, string>>;
	readonly devDependencies?: Readonly<Record<string, string>>;
	readonly peerDependencies?: Readonly<Record<string, string>>;
}

interface TurboTask {
	readonly taskId: string;
	readonly package: string;
	readonly task: string;
	readonly dependencies: readonly string[];
}

interface TurboDryRun {
	readonly tasks: readonly TurboTask[];
}

interface SharedArtifact {
	readonly packageName: string;
	readonly directory: string;
}

const SHARED_ARTIFACTS: readonly SharedArtifact[] = [
	{ packageName: '@owlat/provider-kit', directory: 'packages/provider-kit' },
	{ packageName: '@owlat/plugin-kit', directory: 'packages/plugin-kit' },
];
const ARTIFACT_READING_TASKS = new Set(['build', 'typecheck', 'test', 'test:coverage']);

/**
 * Root scripts allowed to drive other workspace directories. `plugins:prepare`
 * is the sanctioned producer of both public contract packages.
 */
const ROOT_CWD_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
	'plugins:prepare': SHARED_ARTIFACTS.map(({ directory }) => directory),
	'goldens:update': ['packages/mail-message'],
	setup: ['apps/setup-cli'],
	'test:ramp': ['apps/api'],
};

/** Scripts in the producing package that may drive its `tsup --clean`. */
const SANCTIONED_PRODUCER_SCRIPTS = new Set(['build', 'prepack', 'postpack']);

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifests = readWorkspaceManifests();
const failures = [
	...findCrossPackageBuildScripts(manifests),
	...findUnsanctionedRootScripts(),
	...SHARED_ARTIFACTS.flatMap((artifact) => findUnsanctionedProducerScripts(manifests, artifact)),
	...findUnorderedArtifactReaders(manifests, SHARED_ARTIFACTS),
];

if (failures.length > 0) {
	console.error('Build-graph check failed:\n');
	for (const failure of failures) console.error(`  - ${failure}`);
	console.error(
		`\nGuarded contract packages build with \`tsup --clean\`. Every dist reader must be ordered after its package build in turbo.json; no package script may rebuild another workspace inline; and only ${[...SANCTIONED_PRODUCER_SCRIPTS].map((script) => `"${script}"`).join(', ')} may drive a guarded package build. The root manifest may reach workspace directories only through ROOT_CWD_ALLOWLIST.`
	);
	process.exit(1);
}

console.info('Build graph orders every guarded contract-package dist reader after its producer.');

function readWorkspaceManifests(): ReadonlyMap<string, PackageManifest> {
	const directories = ['apps', 'packages', 'examples/plugins']
		.flatMap((group) => {
			const groupRoot = join(workspaceRoot, group);
			if (!existsSync(groupRoot)) return [];
			return readdirSync(groupRoot, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(group, entry.name));
		})
		.concat('examples/conformance');

	const manifests = new Map<string, PackageManifest>();
	for (const directory of directories) {
		const manifestPath = join(workspaceRoot, directory, 'package.json');
		if (!existsSync(manifestPath)) continue;
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest;
		if (!manifest.name) continue;
		manifests.set(manifest.name, manifest);
	}
	return manifests;
}

/** Rule 1: a package script may never drive a build outside its own directory. */
function findCrossPackageBuildScripts(
	manifests: ReadonlyMap<string, PackageManifest>
): readonly string[] {
	const failures: string[] = [];
	for (const [name, manifest] of manifests) {
		for (const [script, command] of Object.entries(manifest.scripts ?? {})) {
			if (!/(^|\s)--cwd(\s|=)/.test(command)) continue;
			failures.push(
				`${name} script "${script}" runs a command in another workspace package (\`--cwd\`): ${command}`
			);
		}
	}
	return failures;
}

/**
 * Rule 1, root half: the root manifest is in scope, with a named allowlist. The
 * root is where the sanctioned producer entry point lives, so a blanket skip
 * would let a future root script become an unordered writer silently.
 */
function findUnsanctionedRootScripts(): readonly string[] {
	const manifest = JSON.parse(
		readFileSync(join(workspaceRoot, 'package.json'), 'utf8')
	) as PackageManifest;

	const failures: string[] = [];
	for (const [script, command] of Object.entries(manifest.scripts ?? {})) {
		const targets = [...command.matchAll(/(?:^|\s)--cwd[\s=]+(\S+)/g)].map((match) =>
			match[1]!.replace(/^\.\//, '').replace(/\/$/, '')
		);
		if (targets.length === 0) continue;
		const allowed = ROOT_CWD_ALLOWLIST[script];
		if (allowed === undefined) {
			failures.push(
				`root script "${script}" drives workspace package(s) (${targets.join(', ')}) but is not in ROOT_CWD_ALLOWLIST — an unordered writer turbo cannot see: ${command}`
			);
			continue;
		}
		const unexpected = targets.filter((target) => !allowed.includes(target));
		const missing = allowed.filter((target) => !targets.includes(target));
		if (unexpected.length > 0 || missing.length > 0) {
			failures.push(
				`root script "${script}" is allowlisted for ${allowed.join(', ')} but targets ${targets.join(', ')}: ${command}`
			);
		}
	}
	return failures;
}

/**
 * Rule 3: only the sanctioned scripts inside the producing package may run the
 * shared artifact's `tsup --clean`, directly or through a pack that fires
 * `prepack`.
 */
function findUnsanctionedProducerScripts(
	manifests: ReadonlyMap<string, PackageManifest>,
	artifact: SharedArtifact
): readonly string[] {
	const manifest = manifests.get(artifact.packageName);
	if (!manifest) return [`workspace manifest for ${artifact.packageName} was not found`];

	const failures: string[] = [];
	for (const [script, command] of Object.entries(manifest.scripts ?? {})) {
		if (SANCTIONED_PRODUCER_SCRIPTS.has(script)) continue;
		if (/(?:^|\s|&&\s*)(?:bun|npm|pnpm|yarn)\s+run\s+build(?:\s|$)/.test(command)) {
			failures.push(
				`${artifact.packageName} script "${script}" rebuilds the shared artifact inline (\`run build\`): ${command}`
			);
			continue;
		}
		if (/(?:^|\s)tsup(?:\s|$)/.test(command)) {
			failures.push(`${artifact.packageName} script "${script}" invokes tsup directly: ${command}`);
			continue;
		}
		if (/\bpm\s+pack\b/.test(command) && !/--ignore-scripts(?:\s|$)/.test(command)) {
			failures.push(
				`${artifact.packageName} script "${script}" packs without \`--ignore-scripts\`, which fires prepack and rebuilds the shared artifact: ${command}`
			);
		}
	}
	return [...failures, ...findProducerHelperRebuilds(artifact)];
}

/**
 * Rule 3, second half: the sanctioned scripts are thin, so a rebuild can hide in
 * the helper sources they call. Scan them for the same three shapes.
 */
function findProducerHelperRebuilds(artifact: SharedArtifact): readonly string[] {
	const scriptsRoot = join(workspaceRoot, artifact.directory, 'scripts');
	if (!existsSync(scriptsRoot)) return [];

	const failures: string[] = [];
	for (const entry of readdirSync(scriptsRoot, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
		const source = stripComments(readFileSync(join(scriptsRoot, entry.name), 'utf8'));
		const location = `${artifact.directory}/scripts/${entry.name}`;
		if (/(?:^|[^\w-])tsup(?:[^\w-]|$)/.test(source)) {
			failures.push(
				`${location} invokes tsup, rebuilding the shared artifact outside its producer`
			);
		}
		if (
			/['"](?:bun|npm|pnpm|yarn)['"]\s*,\s*\[\s*['"]run['"]\s*,\s*['"]build['"]/.test(source) ||
			/(?:bun|npm|pnpm|yarn)\s+run\s+build(?:\s|$|['"`])/.test(source)
		) {
			failures.push(`${location} runs the shared artifact's build outside its producer`);
		}
		if (/['"]pack['"]|\bpm\s+pack\b/.test(source) && !/--ignore-scripts/.test(source)) {
			failures.push(
				`${location} packs without \`--ignore-scripts\`, which fires prepack and rebuilds the shared artifact`
			);
		}
	}
	return failures;
}

/** Comments explain the forbidden patterns by name; only executable code counts. */
function stripComments(source: string): string {
	return source.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/(^|\s)\/\/[^\n]*/g, '$1');
}

/** Rule 2: turbo must order every consumer of the shared dist after its producer. */
function findUnorderedArtifactReaders(
	manifests: ReadonlyMap<string, PackageManifest>,
	artifacts: readonly SharedArtifact[]
): readonly string[] {
	const dryRun = spawnSync(
		process.execPath,
		['x', 'turbo', 'run', 'build', 'typecheck', 'test', 'test:coverage', '--dry=json'],
		{ cwd: workspaceRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
	);
	if (dryRun.error) throw dryRun.error;
	if (dryRun.status !== 0) {
		throw new Error(`Build-graph inspection failed: ${dryRun.stderr.trim()}`);
	}

	const graph = JSON.parse(dryRun.stdout) as TurboDryRun;
	const edges = new Map(graph.tasks.map((task) => [task.taskId, task.dependencies]));
	const failures: string[] = [];
	for (const artifact of artifacts) {
		const producer = `${artifact.packageName}#build`;
		if (!edges.has(producer)) {
			failures.push(`turbo graph does not contain ${producer}`);
			continue;
		}
		const consumers = collectArtifactConsumers(manifests, artifact.packageName);
		for (const task of graph.tasks) {
			// The producing package compiles from src, so it is never its own dist reader.
			if (task.package === artifact.packageName) continue;
			if (!ARTIFACT_READING_TASKS.has(task.task)) continue;
			if (!consumers.has(task.package)) continue;
			if (reaches(edges, task.taskId, producer)) continue;
			failures.push(
				`${task.taskId} reads ${artifact.packageName}'s dist but is not ordered after ${producer}`
			);
		}
	}
	return failures;
}

/** Every workspace package that can resolve the artifact package, directly or not. */
function collectArtifactConsumers(
	manifests: ReadonlyMap<string, PackageManifest>,
	artifactPackage: string
): ReadonlySet<string> {
	const consumers = new Set<string>([artifactPackage]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const [name, manifest] of manifests) {
			if (consumers.has(name)) continue;
			const dependencies = Object.keys({
				...manifest.dependencies,
				...manifest.devDependencies,
				...manifest.peerDependencies,
			});
			if (!dependencies.some((dependency) => consumers.has(dependency))) continue;
			consumers.add(name);
			changed = true;
		}
	}
	return consumers;
}

function reaches(
	edges: ReadonlyMap<string, readonly string[]>,
	from: string,
	target: string
): boolean {
	const seen = new Set<string>();
	const queue = [from];
	while (queue.length > 0) {
		const current = queue.pop() as string;
		for (const dependency of edges.get(current) ?? []) {
			if (dependency === target) return true;
			if (seen.has(dependency)) continue;
			seen.add(dependency);
			queue.push(dependency);
		}
	}
	return false;
}
