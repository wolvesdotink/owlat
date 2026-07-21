/**
 * Guards the one shared build artifact in this monorepo: `packages/plugin-kit/dist`.
 *
 * `@owlat/plugin-kit`'s build is `tsup --clean`, so it wipes and re-emits `dist/`
 * (index.js lands in ~150ms, index.d.ts 2-3s later). Anything reading that
 * directory while the rebuild runs sees a missing or half-written declaration
 * file. The only defence is ordering: the artifact must have a single producer
 * inside turbo's graph, and every consumer task must be a graph descendant of it.
 *
 * Two rules, both of which failed before this guard existed:
 *
 *  1. No workspace package script may run a build in another workspace package.
 *     `@owlat/plugin-codegen` and `@owlat/plugin-cli` used to prefix `test` with
 *     `bun run --cwd ../plugin-kit build`, an unordered writer turbo could not
 *     see, which raced `@owlat/code-worker#typecheck` and `@owlat/api#typecheck`.
 *
 *  2. Every task that can read `packages/plugin-kit/dist` must reach
 *     `@owlat/plugin-kit#build` through turbo's dependency graph.
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

const SHARED_ARTIFACT_PACKAGE = '@owlat/plugin-kit';
const SHARED_ARTIFACT_PRODUCER = `${SHARED_ARTIFACT_PACKAGE}#build`;
const ARTIFACT_READING_TASKS = new Set(['build', 'typecheck', 'test', 'test:coverage']);

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifests = readWorkspaceManifests();
const failures = [
	...findCrossPackageBuildScripts(manifests),
	...findUnorderedArtifactReaders(manifests),
];

if (failures.length > 0) {
	console.error('Build-graph check failed:\n');
	for (const failure of failures) console.error(`  - ${failure}`);
	console.error(
		`\n${SHARED_ARTIFACT_PACKAGE} builds with \`tsup --clean\`. Every task that reads its dist/ must be ordered after ${SHARED_ARTIFACT_PRODUCER} in turbo.json, and no package script may rebuild it inline.`
	);
	process.exit(1);
}

console.info(
	`Build graph orders every reader of ${SHARED_ARTIFACT_PACKAGE}'s dist after ${SHARED_ARTIFACT_PRODUCER}.`
);

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

/** Rule 2: turbo must order every consumer of the shared dist after its producer. */
function findUnorderedArtifactReaders(
	manifests: ReadonlyMap<string, PackageManifest>
): readonly string[] {
	const consumers = collectArtifactConsumers(manifests);
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
	if (!edges.has(SHARED_ARTIFACT_PRODUCER)) {
		return [`turbo graph does not contain ${SHARED_ARTIFACT_PRODUCER}`];
	}

	const failures: string[] = [];
	for (const task of graph.tasks) {
		// The producing package compiles from src (its tsconfig excludes dist and
		// maps the package name onto src/index.ts), so it is never a dist reader.
		if (task.package === SHARED_ARTIFACT_PACKAGE) continue;
		if (!ARTIFACT_READING_TASKS.has(task.task)) continue;
		if (!consumers.has(task.package)) continue;
		if (reaches(edges, task.taskId, SHARED_ARTIFACT_PRODUCER)) continue;
		failures.push(
			`${task.taskId} reads ${SHARED_ARTIFACT_PACKAGE}'s dist but is not ordered after ${SHARED_ARTIFACT_PRODUCER}`
		);
	}
	return failures;
}

/** Every workspace package that can resolve `@owlat/plugin-kit`, directly or not. */
function collectArtifactConsumers(
	manifests: ReadonlyMap<string, PackageManifest>
): ReadonlySet<string> {
	const consumers = new Set<string>([SHARED_ARTIFACT_PACKAGE]);
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
