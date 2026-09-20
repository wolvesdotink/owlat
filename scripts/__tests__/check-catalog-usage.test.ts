/**
 * Workspace manifest guard conformance.
 *
 * `scripts/check-catalog-usage.sh` holds two silent-opt-out invariants: a
 * workspace may not write a literal range for a name the root catalog pins, and
 * a workspace with a `test` script must expose `test:coverage` (the
 * pull-request matrix is built from `turbo run test:coverage --affected`, so a
 * package without the task is simply absent from it).
 *
 * Like the docker guard's suite, the cases run the REAL script against
 * throwaway repositories written on disk, so the assertions are about the
 * shipped gate rather than a reimplementation of it.
 */

import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const run = promisify(execFile);

const GUARD = 'scripts/check-catalog-usage.sh';

const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	roots.length = 0;
});

interface GuardResult {
	readonly code: number;
	readonly output: string;
}

async function runGuard(files: Record<string, string>): Promise<GuardResult> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-catalog-guard-'));
	roots.push(root);

	for (const [path, contents] of Object.entries(files)) {
		const target = join(root, path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, contents, 'utf8');
	}
	await mkdir(join(root, 'scripts'), { recursive: true });
	await copyFile(join(REPOSITORY_ROOT, GUARD), join(root, GUARD));

	try {
		const { stdout, stderr } = await run('bash', [GUARD], { cwd: root });
		return { code: 0, output: `${stdout}${stderr}` };
	} catch (error) {
		const failure = error as { code?: number; stdout?: string; stderr?: string };
		return { code: failure.code ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
	}
}

/** Root manifest with both catalog shapes the real repository uses. */
const ROOT_MANIFEST = JSON.stringify({
	name: 'guard-fixture',
	private: true,
	workspaces: {
		packages: ['apps/*', 'packages/*', '!packages/sdk-java'],
		catalog: { typescript: '^6.0.3' },
		catalogs: { vue: { vue: '^3.5.33' } },
	},
});

function workspace(dependencies: Record<string, string>, scripts: Record<string, string> = {}) {
	return JSON.stringify({ name: 'fixture', devDependencies: dependencies, scripts });
}

describe('workspace manifest guard', () => {
	it('accepts workspaces that reference the catalogs', async () => {
		const result = await runGuard({
			'package.json': ROOT_MANIFEST,
			'apps/web/package.json': workspace({ typescript: 'catalog:', vue: 'catalog:vue' }),
			'packages/shared/package.json': workspace({ typescript: 'catalog:' }),
		});

		expect(result.output).toContain('ok:   all 2 workspaces');
		expect(result.code).toBe(0);
	});

	it('fails a literal range for a catalogued name', async () => {
		const result = await runGuard({
			'package.json': ROOT_MANIFEST,
			'apps/web/package.json': workspace({ typescript: '^7.0.2' }),
		});

		expect(result.output).toContain(
			'FAIL: apps/web/package.json: devDependencies.typescript is "^7.0.2"'
		);
		expect(result.output).toContain('use catalog:');
		expect(result.code).toBe(1);
	});

	it('names the right catalog for a named-catalog pin', async () => {
		const result = await runGuard({
			'package.json': ROOT_MANIFEST,
			'apps/web/package.json': workspace({ vue: '^3.5.0' }),
		});

		expect(result.output).toContain('use catalog:vue');
		expect(result.code).toBe(1);
	});

	it('ignores workspaces excluded by a negated glob', async () => {
		const result = await runGuard({
			'package.json': ROOT_MANIFEST,
			'apps/web/package.json': workspace({ typescript: 'catalog:' }),
			'packages/sdk-java/package.json': workspace({ typescript: '^7.0.2' }),
		});

		expect(result.output).toContain('ok:   all 1 workspaces');
		expect(result.code).toBe(0);
	});

	it('fails a workspace whose tests cannot reach the pull-request matrix', async () => {
		const result = await runGuard({
			'package.json': ROOT_MANIFEST,
			'packages/kit/package.json': workspace({}, { test: 'vitest run' }),
		});

		expect(result.output).toContain('has a "test" script but no "test:coverage"');
		expect(result.code).toBe(1);
	});

	it('accepts a workspace that pairs test with test:coverage', async () => {
		const result = await runGuard({
			'package.json': ROOT_MANIFEST,
			'packages/kit/package.json': workspace(
				{},
				{ test: 'vitest run', 'test:coverage': 'vitest run --coverage' }
			),
		});

		expect(result.code).toBe(0);
	});

	it('holds for the workspaces checked into this repository', async () => {
		const { stdout } = await run('bash', [GUARD], { cwd: REPOSITORY_ROOT });

		expect(stdout).toMatch(/^ok: {3}all \d+ workspaces take their \d+ catalogued pins/);
	});
});
