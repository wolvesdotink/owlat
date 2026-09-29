/**
 * vitest.shared.ts is the one copy of the per-workspace vitest boilerplate.
 *
 * Before it, 26 configs repeated the same coverage block and nine carried an
 * `@` source alias (with a matching tsconfig `paths` entry in eight packages)
 * that no file imported. The helper checks pin its output; the tree checks read
 * the real configs so a copied-back block or a revived alias fails the PR that
 * adds it.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { coverageReports, nodePackageConfig, packageCoverage } from '../../vitest.shared';
import { PARALLEL_GATE_TIMEOUT_MS } from '../../vitest.timeouts';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function trackedFiles(pattern: RegExp): string[] {
	return execFileSync('git', ['ls-files'], { cwd: REPOSITORY_ROOT, encoding: 'utf8' })
		.split('\n')
		.filter((file) => pattern.test(file));
}

function read(relativePath: string): string {
	return readFileSync(join(REPOSITORY_ROOT, relativePath), 'utf8');
}

describe('packageCoverage', () => {
	it('measures src and never counts test files', () => {
		expect(packageCoverage({ lines: 80 })).toEqual({
			provider: 'v8',
			reporter: ['text', 'json-summary', 'html'],
			reportsDirectory: './coverage',
			include: ['src/**/*.ts'],
			exclude: ['**/__tests__/**'],
			thresholds: { lines: 80 },
		});
	});

	it('appends package exclusions after the test trees', () => {
		expect(packageCoverage({ lines: 1, exclude: ['src/index.ts'] }).exclude).toEqual([
			'**/__tests__/**',
			'src/index.ts',
		]);
	});

	it('merges further floors next to the line floor', () => {
		expect(
			packageCoverage({
				lines: 90,
				thresholds: { branches: 85, 'src/parse/**': { lines: 90 } },
			}).thresholds
		).toEqual({ lines: 90, branches: 85, 'src/parse/**': { lines: 90 } });
	});

	it('sets no thresholds for a workspace without a floor', () => {
		expect(packageCoverage({ exclude: ['src/index.ts'] })).not.toHaveProperty('thresholds');
	});

	it('shares its reporting half with coverageReports', () => {
		expect(packageCoverage()).toMatchObject(coverageReports());
	});
});

describe('nodePackageConfig', () => {
	it('keeps vitest default timeouts unless the parallel-gate budget is asked for', () => {
		const plain = nodePackageConfig({ coverage: { lines: 50 } });
		expect(plain.test).toMatchObject({
			include: ['src/**/__tests__/**/*.test.ts'],
			environment: 'node',
		});
		expect(plain.test).not.toHaveProperty('testTimeout');
		expect(plain.test).not.toHaveProperty('hookTimeout');

		const gated = nodePackageConfig({ coverage: { lines: 50 }, timeout: 'parallel-gate' });
		expect(gated.test?.testTimeout).toBe(PARALLEL_GATE_TIMEOUT_MS);
		expect(gated.test?.hookTimeout).toBe(PARALLEL_GATE_TIMEOUT_MS);
	});
});

describe('workspace vitest configs', () => {
	const configs = trackedFiles(/(^|\/)vitest\.config\.ts$/);

	it('finds the configs', () => {
		expect(configs.length).toBeGreaterThan(20);
	});

	it('build coverage through vitest.shared.ts instead of a local copy', () => {
		const copies = configs.filter((file) => /provider:\s*['"]v8['"]/.test(read(file)));
		expect(copies).toEqual([]);
	});

	it('carry no bare `@` source alias', () => {
		const aliased = configs.filter((file) => /['"]@['"]\s*:/.test(read(file)));
		expect(aliased).toEqual([]);
	});

	it('leave no `@/*` path in a package tsconfig', () => {
		const withPaths = trackedFiles(/^(packages|apps)\/[^/]+\/tsconfig\.json$/).filter((file) =>
			read(file).includes('"@/*"')
		);
		expect(withPaths).toEqual([]);
	});
});
