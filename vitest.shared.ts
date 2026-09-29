/**
 * The vitest boilerplate every workspace shares, so a package config states only
 * what is actually its own: which files count, which are exempt and why, and
 * its ratcheted coverage floor.
 *
 * Coverage reports go to `./coverage` in the three formats CI uploads (see
 * scripts/quality-ratchets.md for how floors are set and raised). Test files
 * never count toward coverage: `**\/__tests__/**` is always excluded, whatever
 * else a package adds.
 *
 * Changing this file invalidates every turbo test cache (turbo.json
 * `globalDependencies`), exactly like vitest.timeouts.ts.
 */
import { defineConfig } from 'vitest/config';
import type { CoverageOptions } from 'vitest/node';
import { PARALLEL_GATE_TIMEOUT_MS } from './vitest.timeouts';

type Thresholds = NonNullable<CoverageOptions['thresholds']>;

interface PackageCoverageOptions {
	/**
	 * The package's ratcheted line floor. Omit it only for a workspace that has
	 * no floor yet; every other threshold goes in `thresholds`.
	 */
	lines?: number;
	/** Further floors (branches, per-glob floors) merged next to `lines`. */
	thresholds?: Thresholds;
	/** Files measured, including ones no test loads. */
	include?: string[];
	/** Files exempt beyond the always-excluded `__tests__` trees. */
	exclude?: string[];
}

/** Provider, reporters and output directory, without any file selection. */
export function coverageReports(): CoverageOptions {
	return {
		provider: 'v8',
		reporter: ['text', 'json-summary', 'html'],
		reportsDirectory: './coverage',
	};
}

/** A workspace's coverage block: shared reporting plus its own files and floor. */
export function packageCoverage({
	lines,
	thresholds,
	include = ['src/**/*.ts'],
	exclude = [],
}: PackageCoverageOptions = {}): CoverageOptions {
	const floors: Thresholds | undefined =
		lines === undefined ? thresholds : { ...thresholds, lines };
	return {
		...coverageReports(),
		include,
		exclude: ['**/__tests__/**', ...exclude],
		...(floors ? { thresholds: floors } : {}),
	};
}

interface NodePackageConfigOptions {
	/** Test files. Defaults to `src/**\/__tests__/**\/*.test.ts`. */
	include?: string[];
	coverage: PackageCoverageOptions;
	/**
	 * `'parallel-gate'` takes the shared budget from vitest.timeouts.ts for a
	 * suite with a large fixed cost per test; say why at the call site.
	 * `'default'` keeps vitest's tight 5000ms so a hang fails fast.
	 */
	timeout?: 'default' | 'parallel-gate';
}

/**
 * The whole config for a plain node package: tests under `src`, the node
 * environment, the package's coverage block and, when warranted, the shared
 * parallel-gate time budget. Packages with plugins, aliases or setup files use
 * `defineConfig` with `packageCoverage` instead.
 */
export function nodePackageConfig({
	include = ['src/**/__tests__/**/*.test.ts'],
	coverage,
	timeout = 'default',
}: NodePackageConfigOptions) {
	return defineConfig({
		test: {
			include,
			environment: 'node',
			...(timeout === 'parallel-gate'
				? { testTimeout: PARALLEL_GATE_TIMEOUT_MS, hookTimeout: PARALLEL_GATE_TIMEOUT_MS }
				: {}),
			coverage: packageCoverage(coverage),
		},
	});
}
