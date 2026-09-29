/**
 * Shared fixture for the tests of the Convex definition gates in
 * `apps/api/scripts/` (check-errors, check-query-authz, check-permissions and
 * the builder derivation they share).
 *
 * `apiTree()` builds a throwaway `apps/api` tree holding the REAL gate scripts,
 * the REAL `scripts/lib/` they source, and the two inputs the builder
 * derivation reads from source: the real `convex/lib/authedFunctions.ts` and
 * one module carrying every `featureGated(Any)` composition line found in the
 * real `convex/` tree. A case then seeds the `convex/` files it needs, so the
 * gates run against code without touching the repository they guard.
 */

import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const API_ROOT = join(REPOSITORY_ROOT, 'apps/api');
const CONVEX_ROOT = join(API_ROOT, 'convex');
export const AUTHED_FUNCTIONS = 'convex/lib/authedFunctions.ts';

/** A `(export )?const <name> = featureGated(Any)?(<base>,` composition line. */
export const COMPOSITION =
	/^(?:export )?const ([A-Za-z0-9_]+) = featureGated(?:Any)?\(\s*([A-Za-z0-9_]+)/;

const run = promisify(execFile);

export interface GateResult {
	readonly code: number;
	readonly output: string;
	readonly stdout: string;
}

/** Every production `.ts` file under the real `convex/`, as `convex/…` paths. */
export async function convexSourceFiles(): Promise<string[]> {
	const entries = await readdir(CONVEX_ROOT, { recursive: true, withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
		.map((entry) => relative(API_ROOT, join(entry.parentPath, entry.name)))
		.filter(
			(path) =>
				!path.includes('/_generated/') &&
				!path.includes('/__tests__/') &&
				!path.endsWith('.test.ts')
		)
		.sort();
}

/** The composition lines of the real tree, outside lib/authedFunctions.ts. */
async function realCompositionLines(): Promise<string[]> {
	const lines: string[] = [];
	for (const path of await convexSourceFiles()) {
		if (path === AUTHED_FUNCTIONS) continue;
		const source = await readFile(join(API_ROOT, path), 'utf8');
		lines.push(...source.split('\n').filter((line) => COMPOSITION.test(line)));
	}
	return lines;
}

/**
 * Build a throwaway repository whose `apps/api` holds the real gates, their
 * shared lib, the builder sources, and `files` (paths relative to `apps/api`).
 * Returns the repository root.
 */
export async function apiTree(files: Record<string, string>, roots: string[]): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-convex-gate-'));
	roots.push(root);
	const api = join(root, 'apps/api');

	const scripts = join(API_ROOT, 'scripts');
	await mkdir(join(api, 'scripts/lib'), { recursive: true });
	for (const name of await readdir(scripts)) {
		if (name.endsWith('.sh')) await copyFile(join(scripts, name), join(api, 'scripts', name));
	}
	for (const name of await readdir(join(scripts, 'lib'))) {
		await copyFile(join(scripts, 'lib', name), join(api, 'scripts/lib', name));
	}

	const seeded: Record<string, string> = {
		[AUTHED_FUNCTIONS]: await readFile(join(API_ROOT, AUTHED_FUNCTIONS), 'utf8'),
		'convex/fixtureBuilders.ts': `${(await realCompositionLines()).join('\n')}\n`,
		...files,
	};
	for (const [path, contents] of Object.entries(seeded)) {
		const target = join(api, path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, contents, 'utf8');
	}
	return root;
}

/** Run `apps/api/scripts/<gate>` inside `root` and capture its exit code. */
export async function runGate(
	root: string,
	gate: string,
	args: string[] = []
): Promise<GateResult> {
	try {
		const { stdout, stderr } = await run('bash', [`apps/api/scripts/${gate}`, ...args], {
			cwd: root,
		});
		return { code: 0, output: `${stdout}${stderr}`, stdout };
	} catch (error) {
		const failure = error as { code?: number; stdout?: string; stderr?: string };
		return {
			code: failure.code ?? 1,
			output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
			stdout: failure.stdout ?? '',
		};
	}
}

/** Remove every tree `apiTree` created. */
export async function removeTrees(roots: string[]): Promise<void> {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	roots.length = 0;
}
