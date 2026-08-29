import { describe, expect, it } from 'vitest';
import type { ViteUserConfig } from 'vitest/config';
import vitestConfig from '../../vitest.config';
import { PARALLEL_GATE_TIMEOUT_MS, VITEST_DEFAULT_TIMEOUT_MS } from '../../../../vitest.timeouts';

/**
 * Release-gate guard for apps/web.
 *
 * The composable specs here reload the module under test from inside the case
 * (`vi.resetModules()` + `await import(...)`), because the Nuxt auto-import
 * stubs must be in place before the graph evaluates. That fixed transform cost
 * is milliseconds in isolation, but the root `ci:test` gate runs every turbo
 * test task at once and it grows by roughly an order of magnitude — which
 * exceeded vitest's 5000ms default and made the gate fail on machine load
 * rather than on code.
 *
 * The assertions are deliberately deterministic: they read the configured
 * budget rather than timing anything, because a guard that measured wall-clock
 * time would itself be load-sensitive — exactly the defect it exists to
 * prevent. The budget's sizing lives in vitest.timeouts.ts.
 */
const MIN_HEADROOM_FACTOR = 12;

describe('web vitest timeout budget', () => {
	const config = vitestConfig as ViteUserConfig;

	it('configures an explicit test timeout instead of the 5000ms default', () => {
		expect(config.test?.testTimeout).toBeTypeOf('number');
		expect(config.test?.hookTimeout).toBeTypeOf('number');
		expect(config.test?.testTimeout).not.toBe(VITEST_DEFAULT_TIMEOUT_MS);
	});

	it('takes its budget from the shared root budget rather than a local literal', () => {
		expect(config.test?.testTimeout).toBe(PARALLEL_GATE_TIMEOUT_MS);
		expect(config.test?.hookTimeout).toBe(PARALLEL_GATE_TIMEOUT_MS);
	});

	it('keeps an order-of-magnitude margin over the default for the contended run', () => {
		expect(PARALLEL_GATE_TIMEOUT_MS).toBeGreaterThanOrEqual(
			VITEST_DEFAULT_TIMEOUT_MS * MIN_HEADROOM_FACTOR
		);
	});
});
