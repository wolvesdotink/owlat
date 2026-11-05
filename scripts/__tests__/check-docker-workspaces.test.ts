/**
 * Docker workspace-manifest guard conformance.
 *
 * `scripts/check-docker-workspaces.sh` is what keeps every image's
 * `COPY --parents … package.json` line in step with the root `workspaces`
 * globs — the invariant that broke every image at once when `examples/*` was
 * added. A guard that quietly skips an image it cannot parse is worse than no
 * guard, so the script is exercised here against throwaway repositories built
 * on disk: the REAL script file, copied into a synthetic root whose Dockerfiles
 * and workspaces are written per case.
 *
 * The cases pin the ways an image could otherwise fall out of the guard's
 * sight: a purely cosmetic backslash re-wrap of the COPY instruction, an image
 * that installs from the frozen lockfile without copying any manifest, a
 * frozen-install stage that omits the root dependency patches, and a context
 * that pulls in a tsconfig.json without the base config it extends.
 *
 * The source-closure half of the guard is exercised the same way. Its cases pin
 * the regression it was added for (a workspace whose source is copied without
 * its dependency's source) and the two asymmetries that keep it quiet on the
 * real tree: a `--from=<stage>` copy satisfies a dependency without demanding
 * one, and a manifest-only copy is not a source copy.
 *
 * The failure-report cases pin that a failing guard always says why on
 * stderr, including when node is missing, exits without a word, or is killed.
 */

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const run = promisify(execFile);

const GUARD = 'scripts/check-docker-workspaces.sh';

const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	roots.length = 0;
});

interface GuardResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	/** Both streams together, for assertions and for failure messages. */
	readonly output: string;
}

/** Absolute path of `name` on this process's PATH. */
async function which(name: string): Promise<string> {
	for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, name);
		try {
			await access(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Not in this PATH entry.
		}
	}
	throw new Error(`${name} is not on PATH`);
}

/**
 * Run the guard in `cwd` and capture its exit code and both streams, whether it
 * passes or fails. A rejected `execFile` promise's message holds only stderr,
 * so awaiting `run` directly would drop every stdout line from a failure report.
 *
 * bash is spawned by absolute path so that a PATH built for one case (one
 * without node, say) does not also decide which shell runs the guard.
 */
async function captureGuard(cwd: string, env?: NodeJS.ProcessEnv): Promise<GuardResult> {
	try {
		const { stdout, stderr } = await run(await which('bash'), [GUARD], { cwd, env });
		return { code: 0, stdout, stderr, output: `${stdout}${stderr}` };
	} catch (error) {
		const failure = error as { code?: number; stdout?: string; stderr?: string };
		const stdout = failure.stdout ?? '';
		const stderr = failure.stderr ?? '';
		return { code: failure.code ?? 1, stdout, stderr, output: `${stdout}${stderr}` };
	}
}

/** The tools the guard shells out to, apart from node. */
const GUARD_TOOLS = ['dirname', 'git', 'sed', 'grep', 'xargs', 'tr', 'head', 'cut'];

/**
 * A bin directory inside `root` that holds only the guard's tools, plus an
 * optional `node` script standing in for the real one. Leaving the script out
 * gives a PATH without node.
 */
async function guardBin(root: string, nodeShim: string | null): Promise<string> {
	const bin = join(root, '.bin');
	await mkdir(bin, { recursive: true });
	for (const tool of GUARD_TOOLS) await symlink(await which(tool), join(bin, tool));
	if (nodeShim !== null) {
		await writeFile(join(bin, 'node'), nodeShim, 'utf8');
		await chmod(join(bin, 'node'), 0o755);
	}
	return bin;
}

/**
 * Build a repository containing the real guard plus `files`, and run it.
 *
 * `git init` + `git add` are required because the guard enumerates images with
 * `git ls-files`, exactly as it does in this repository.
 *
 * With `nodeShim` set, the guard runs on a PATH from `guardBin`: the string is
 * the `node` it finds, and `null` leaves node off the PATH.
 */
async function runGuard(
	files: Record<string, string>,
	options: { readonly nodeShim?: string | null } = {}
): Promise<GuardResult> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-docker-guard-'));
	roots.push(root);

	for (const [path, contents] of Object.entries(files)) {
		const target = join(root, path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, contents, 'utf8');
	}
	await mkdir(join(root, 'scripts'), { recursive: true });
	await copyFile(join(REPOSITORY_ROOT, GUARD), join(root, GUARD));

	await run('git', ['init', '--quiet'], { cwd: root });
	await run('git', ['add', '--all'], { cwd: root });

	if (options.nodeShim === undefined) return captureGuard(root);
	// Created after `git add`, so the bin directory never reaches the guard's
	// `git ls-files`.
	const bin = await guardBin(root, options.nodeShim);
	return captureGuard(root, { ...process.env, PATH: bin });
}

/** Root manifest declaring the two workspace shapes the real repository has. */
const ROOT_MANIFEST = JSON.stringify({
	name: 'guard-fixture',
	private: true,
	workspaces: ['apps/*', 'examples/*'],
});

const WORKSPACES = {
	'package.json': ROOT_MANIFEST,
	'apps/web/package.json': '{"name":"web"}',
	'examples/conformance/package.json': '{"name":"conformance"}',
};

const ALL_GLOBS = 'apps/*/package.json examples/*/package.json';

/** A single-line COPY image, the shape every image in this repository uses. */
function flatImage(globs = ALL_GLOBS): string {
	return [
		'FROM oven/bun:1 AS build',
		`COPY --parents ${globs} ./`,
		'RUN bun install --frozen-lockfile',
		'',
	].join('\n');
}

/** The same instruction, wrapped across backslash continuations. */
function wrappedImage(globs = ALL_GLOBS): string {
	const lines = globs.split(' ').map((glob) => `\t${glob} \\`);
	return [
		'FROM oven/bun:1 AS build',
		'COPY --parents \\',
		...lines,
		'\t./',
		'RUN bun install --frozen-lockfile',
		'',
	].join('\n');
}

function patchedMultiStageImage(copyPatchesInRuntimeDeps = true): string {
	return [
		'FROM oven/bun:1 AS build',
		`COPY --parents ${ALL_GLOBS} ./`,
		'COPY patches/ patches/',
		'RUN bun install --frozen-lockfile',
		'FROM oven/bun:1 AS runtime-deps',
		`COPY --parents ${ALL_GLOBS} ./`,
		...(copyPatchesInRuntimeDeps ? ['COPY patches/ patches/'] : []),
		'RUN bun install --frozen-lockfile --production',
		'',
	].join('\n');
}

describe('docker workspace-manifest guard', () => {
	it('accepts images that copy every workspace manifest', async () => {
		const result = await runGuard({
			...WORKSPACES,
			'apps/web/Dockerfile': flatImage(),
			'docker/other.Dockerfile': flatImage(),
		});

		expect(result.output).toContain(
			'all 2 Dockerfiles copy every one of the 2 workspace manifests'
		);
		expect(result.code).toBe(0);
	});

	it('still checks an image whose COPY is wrapped across continuations', async () => {
		const result = await runGuard({
			...WORKSPACES,
			'apps/web/Dockerfile': wrappedImage(),
			'docker/other.Dockerfile': flatImage(),
		});

		// Both images are counted: a cosmetic re-wrap must not shrink the guard.
		expect(result.output).toContain('all 2 Dockerfiles');
		expect(result.code).toBe(0);
	});

	it('fails a wrapped COPY that drops a workspace glob', async () => {
		const result = await runGuard({
			...WORKSPACES,
			'apps/web/Dockerfile': wrappedImage('apps/*/package.json'),
			'docker/other.Dockerfile': flatImage(),
		});

		expect(result.stderr).toContain(
			'FAIL: apps/web/Dockerfile does not copy examples/conformance/package.json'
		);
		expect(result.code).toBe(1);
	});

	it('fails an image that installs from the frozen lockfile without copying manifests', async () => {
		const result = await runGuard({
			...WORKSPACES,
			'apps/web/Dockerfile': flatImage(),
			'docker/other.Dockerfile': [
				'FROM oven/bun:1 AS build',
				'COPY . .',
				'RUN bun install --frozen-lockfile',
				'',
			].join('\n'),
		});

		expect(result.output).toContain(
			"FAIL: docker/other.Dockerfile runs 'bun install --frozen-lockfile' but copies no workspace manifests"
		);
		expect(result.code).toBe(1);
	});

	it('ignores an image that neither copies manifests nor installs from the lockfile', async () => {
		const result = await runGuard({
			...WORKSPACES,
			'apps/web/Dockerfile': flatImage(),
			'docker/runtime.Dockerfile': ['FROM alpine:3', 'CMD ["/bin/sh"]', ''].join('\n'),
		});

		expect(result.output).toContain('all 1 Dockerfiles');
		expect(result.code).toBe(0);
	});

	it('requires dependency patches in every frozen-install stage', async () => {
		const result = await runGuard({
			...WORKSPACES,
			'package.json': JSON.stringify({
				...JSON.parse(ROOT_MANIFEST),
				patchedDependencies: { 'example@1.0.0': 'patches/example.patch' },
			}),
			'patches/example.patch': 'synthetic patch fixture',
			'apps/web/Dockerfile': patchedMultiStageImage(),
		});

		expect(result.output).toContain('and required dependency patches');
		expect(result.code).toBe(0);
	});

	it('fails when a later frozen-install stage omits dependency patches', async () => {
		const result = await runGuard({
			...WORKSPACES,
			'package.json': JSON.stringify({
				...JSON.parse(ROOT_MANIFEST),
				patchedDependencies: { 'example@1.0.0': 'patches/example.patch' },
			}),
			'patches/example.patch': 'synthetic patch fixture',
			'apps/web/Dockerfile': patchedMultiStageImage(false),
		});

		expect(result.output).toContain(
			'FAIL: apps/web/Dockerfile runs a frozen Bun install without copying patches/ in that stage'
		);
		expect(result.code).toBe(1);
	});

	it('fails an image that copies a tsconfig extending the base without the base', async () => {
		const result = await runGuard({
			...WORKSPACES,
			'tsconfig.base.json': '{"compilerOptions":{"strict":true}}',
			'apps/web/tsconfig.json': '{"extends":"../../tsconfig.base.json"}',
			'apps/web/Dockerfile': [
				'FROM oven/bun:1 AS build',
				`COPY --parents ${ALL_GLOBS} ./`,
				'RUN bun install --frozen-lockfile',
				'COPY apps/web/tsconfig.json apps/web/',
				'RUN cd apps/web && bun run build',
				'',
			].join('\n'),
		});

		expect(result.output).toContain(
			'FAIL: apps/web/Dockerfile copies apps/web/tsconfig.json, which extends tsconfig.base.json'
		);
		expect(result.code).toBe(1);
	});

	it('accepts the same image once it copies the base config', async () => {
		const result = await runGuard({
			...WORKSPACES,
			'tsconfig.base.json': '{"compilerOptions":{"strict":true}}',
			'apps/web/tsconfig.json': '{"extends":"../../tsconfig.base.json"}',
			'apps/web/Dockerfile': [
				'FROM oven/bun:1 AS build',
				`COPY --parents ${ALL_GLOBS} ./`,
				'RUN bun install --frozen-lockfile',
				'COPY tsconfig.base.json ./',
				'COPY apps/web/tsconfig.json apps/web/',
				'RUN cd apps/web && bun run build',
				'',
			].join('\n'),
		});

		expect(result.code).toBe(0);
	});

	// The config need not be named on a COPY line of its own: sweeping in the
	// directory that holds it is how apps/setup-cli's image acquires one.
	it('sees a tsconfig swept in with its directory', async () => {
		const result = await runGuard({
			...WORKSPACES,
			'tsconfig.base.json': '{"compilerOptions":{"strict":true}}',
			'packages/shared/tsconfig.json': '{"extends":"../../tsconfig.base.json"}',
			'apps/web/Dockerfile': [
				'FROM oven/bun:1 AS build',
				`COPY --parents ${ALL_GLOBS} ./`,
				'RUN bun install --frozen-lockfile',
				'COPY packages/shared packages/shared',
				'RUN cd packages/shared && bun run build',
				'',
			].join('\n'),
		});

		expect(result.output).toContain(
			'FAIL: apps/web/Dockerfile copies packages/shared/tsconfig.json, which extends tsconfig.base.json'
		);
		expect(result.code).toBe(1);
	});

	it('leaves a standalone tsconfig alone', async () => {
		const result = await runGuard({
			...WORKSPACES,
			'apps/web/tsconfig.json': '{"compilerOptions":{"strict":true}}',
			'apps/web/Dockerfile': [
				'FROM oven/bun:1 AS build',
				`COPY --parents ${ALL_GLOBS} ./`,
				'RUN bun install --frozen-lockfile',
				'COPY apps/web/tsconfig.json apps/web/',
				'',
			].join('\n'),
		});

		expect(result.code).toBe(0);
	});

	/**
	 * A two-workspace graph: `lib` depends on `dep`, both in-repo. This is the
	 * `@owlat/shared` → `@owlat/mail-message` edge that broke the updater and
	 * setup images, reduced to its smallest form.
	 */
	const CLOSURE_WORKSPACES = {
		'package.json': JSON.stringify({
			name: 'guard-fixture',
			private: true,
			workspaces: ['apps/*', 'packages/*'],
		}),
		'apps/web/package.json': '{"name":"web"}',
		'packages/lib/package.json': JSON.stringify({
			name: 'lib',
			dependencies: { dep: 'workspace:*' },
		}),
		'packages/dep/package.json': '{"name":"dep"}',
	};

	const CLOSURE_GLOBS = 'apps/*/package.json packages/*/package.json';

	function closureImage(copyLines: readonly string[]): string {
		return [
			'FROM oven/bun:1 AS build',
			`COPY --parents ${CLOSURE_GLOBS} ./`,
			'RUN bun install --frozen-lockfile',
			...copyLines,
			'',
		].join('\n');
	}

	it('fails an image copying a workspace source without its dependency source', async () => {
		const result = await runGuard({
			...CLOSURE_WORKSPACES,
			'apps/web/Dockerfile': closureImage(['COPY packages/lib packages/lib']),
		});

		expect(result.output).toContain(
			'FAIL: apps/web/Dockerfile (stage 1) copies lib source but not its dependency dep (packages/dep)'
		);
		expect(result.code).toBe(1);
	});

	it('accepts the same image once the dependency source travels with it', async () => {
		const result = await runGuard({
			...CLOSURE_WORKSPACES,
			'apps/web/Dockerfile': closureImage([
				'COPY packages/lib packages/lib',
				'COPY packages/dep packages/dep',
			]),
		});

		expect(result.output).toContain("copies a workspace's source copies its dependency closure");
		expect(result.code).toBe(0);
	});

	it('accepts a partial source copy that mirrors the src/ granularity', async () => {
		// apps/updater copies `packages/shared/src`, not the whole package; the
		// guard must read that as covering the workspace.
		const result = await runGuard({
			...CLOSURE_WORKSPACES,
			'apps/web/Dockerfile': closureImage([
				'COPY packages/lib/src packages/lib/src',
				'COPY packages/dep/src packages/dep/src',
			]),
		});

		expect(result.code).toBe(0);
	});

	it('lets a --from= copy satisfy a dependency without demanding one', async () => {
		// docker/convex-deploy.Dockerfile's real shape: the dependency arrives as a
		// built artifact from an earlier stage, with only its manifest from context.
		const result = await runGuard({
			...CLOSURE_WORKSPACES,
			'apps/web/Dockerfile': [
				'FROM oven/bun:1 AS deps',
				`COPY --parents ${CLOSURE_GLOBS} ./`,
				'RUN bun install --frozen-lockfile',
				'FROM oven/bun:1 AS build',
				`COPY --parents ${CLOSURE_GLOBS} ./`,
				'COPY packages/lib packages/lib',
				'COPY --from=deps /app/packages/dep/dist/ packages/dep/dist/',
				'',
			].join('\n'),
		});

		expect(result.code).toBe(0);
	});

	it('does not read the manifest COPY line as a source copy', async () => {
		// `COPY --parents packages/*/package.json ./` must never trip the closure
		// check, or every image would fail it.
		const result = await runGuard({
			...CLOSURE_WORKSPACES,
			'apps/web/Dockerfile': closureImage([]),
		});

		expect(result.output).not.toContain('source but not its dependency');
		expect(result.code).toBe(0);
	});

	// The only case here that runs the guard over the REAL tree: a `git ls-files`
	// plus a parse of every Dockerfile in the repository.
	it('holds for the images checked into this repository', async () => {
		const result = await captureGuard(REPOSITORY_ROOT);

		// The guard's whole output is the assertion message, so a failure names
		// the image and the manifest the guard objected to.
		expect(result.code, result.output).toBe(0);
		expect(result.stdout).toMatch(
			/^ok: {3}all \d+ Dockerfiles copy every one of the \d+ workspace manifests/
		);
	});
});

describe('docker workspace-manifest guard failure reports', () => {
	const IMAGES = {
		...WORKSPACES,
		'apps/web/Dockerfile': flatImage(),
	};

	it('writes its failures and their explanation to stderr', async () => {
		const result = await runGuard({
			...WORKSPACES,
			'apps/web/Dockerfile': flatImage('apps/*/package.json'),
		});

		expect(result.stderr).toContain(
			'FAIL: apps/web/Dockerfile does not copy examples/conformance/package.json'
		);
		expect(result.stderr).toContain("Each image's 'COPY --parents");
		expect(result.stdout).toBe('');
		expect(result.code).toBe(1);
	});

	it('names node when it is not on PATH', async () => {
		const result = await runGuard(IMAGES, { nodeShim: null });

		expect(result.stderr).toContain('FAIL: node is not on PATH');
		expect(result.code).toBe(1);
	});

	it('names the step when node exits non-zero without a word', async () => {
		const result = await runGuard(IMAGES, { nodeShim: '#!/bin/sh\nexit 3\n' });

		expect(result.stderr).toContain('FAIL: reading the root workspaces globs: node exited 3');
		expect(result.code).toBe(1);
	});

	it('names the step and the signal when node is killed', async () => {
		// Only the closure script calls execSync. Every other node call reaches
		// the real binary, so the guard gets as far as the closure check.
		const result = await runGuard(IMAGES, {
			nodeShim: [
				'#!/bin/sh',
				'case "$2" in',
				'*execSync*) kill -KILL $$ ;;',
				`*) exec '${process.execPath}' "$@" ;;`,
				'esac',
				'',
			].join('\n'),
		});

		expect(result.stderr).toContain(
			'FAIL: source closure check: node exited 137 (killed by SIGKILL)'
		);
		expect(result.code).toBe(1);
	});
});
