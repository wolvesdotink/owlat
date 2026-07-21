import { describe, it, expect, vi } from 'vitest';
import type { UserConfig } from 'vitest/config';
import vitestConfig from '../../vitest.config';

/**
 * Release-gate guard for the email-block host tests.
 *
 * `src/host/__tests__/*.test.ts` reload the entire module graph on every single
 * test (`vi.resetModules()` then dynamic import) because the block registries are
 * module-level one-way latches. That is a deliberate, irreducible fixed cost per
 * test. Under `bun run ci:test` every turbo test task runs at once and the cost
 * grows by roughly an order of magnitude, which used to exceed vitest's 5000ms
 * default and made `ci:verify` — and therefore the release workflow — flake.
 *
 * This test pins the package's configured budget to a multiple of the measured
 * cost so nobody can drop back to the default.
 */
const MIN_TIMEOUT_MS = 20_000;
const RELOAD_BUDGET_FACTOR = 4;

async function measureModuleGraphReload(): Promise<number> {
	const started = performance.now();
	vi.resetModules();
	await import('../host/emailBlockHost');
	await import('@owlat/email-renderer');
	await import('../registry/blockRegistry');
	await import('@owlat/plugin-kit');
	return performance.now() - started;
}

describe('email-builder vitest timeout budget', () => {
	it('configures an explicit test timeout instead of the 5000ms default', () => {
		const config = vitestConfig as UserConfig;
		expect(config.test?.testTimeout).toBeTypeOf('number');
		expect(config.test?.testTimeout ?? 0).toBeGreaterThanOrEqual(MIN_TIMEOUT_MS);
		expect(config.test?.hookTimeout ?? 0).toBeGreaterThanOrEqual(MIN_TIMEOUT_MS);
	});

	it('budgets at least 4x the measured module-graph reload the host tests perform', async () => {
		// Warm the transform cache first so the measurement reflects a steady-state
		// reload rather than the very first compile of the graph.
		await measureModuleGraphReload();
		const reloadMs = await measureModuleGraphReload();
		const configured = (vitestConfig as UserConfig).test?.testTimeout ?? 0;
		expect(configured).toBeGreaterThanOrEqual(reloadMs * RELOAD_BUDGET_FACTOR);
	});
});
