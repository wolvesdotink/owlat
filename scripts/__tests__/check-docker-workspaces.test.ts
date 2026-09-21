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
 */

import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { PARALLEL_GATE_TIMEOUT_MS } from '../../vitest.timeouts';

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
	readonly output: string;
}

/**
 * Build a repository containing the real guard plus `files`, and run it.
 *
 * `git init` + `git add` are required because the guard enumerates images with
 * `git ls-files`, exactly as it does in this repository.
 */
async function runGuard(files: Record<string, string>): Promise<GuardResult> {
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

	try {
		const { stdout, stderr } = await run('bash', [GUARD], { cwd: root });
		return { code: 0, output: `${stdout}${stderr}` };
	} catch (error) {
		const failure = error as { code?: number; stdout?: string; stderr?: string };
		return { code: failure.code ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
	}
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

		expect(result.output).toContain(
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
	 * setup images in PR #733, reduced to its smallest form.
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
	// plus a parse of every Dockerfile in the repository. That fixed subprocess
	// cost is well inside vitest's 5s default standalone, but this file shares a
	// worker pool with the other gate suites — each of which also shells out —
	// and it timed out at 5s once the pool grew. Take the shared gate budget, as
	// check-convex-node-globals.test.ts does for its own real-repository case.
	it(
		'holds for the images checked into this repository',
		async () => {
			const { stdout } = await run('bash', [GUARD], { cwd: REPOSITORY_ROOT });

			expect(stdout).toMatch(
				/^ok: {3}all \d+ Dockerfiles copy every one of the \d+ workspace manifests/
			);
		},
		PARALLEL_GATE_TIMEOUT_MS
	);
});
