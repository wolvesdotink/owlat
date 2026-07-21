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
 * The cases pin the two ways an image could otherwise fall out of the guard's
 * sight: a purely cosmetic backslash re-wrap of the COPY instruction, and an
 * image that installs from the frozen lockfile without copying any manifest.
 */

import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { REPOSITORY_ROOT } from '../repository';

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

	it('holds for the images checked into this repository', async () => {
		const { stdout } = await run('bash', [GUARD], { cwd: REPOSITORY_ROOT });

		expect(stdout).toMatch(
			/^ok: {3}all \d+ Dockerfiles copy every one of the \d+ workspace manifests/
		);
	});
});
