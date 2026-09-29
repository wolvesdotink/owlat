import { describe, expect, it } from 'vitest';
import type { ViteUserConfig } from 'vitest/config';
import vitestConfig from '../../vitest.config';
import { PARALLEL_GATE_TIMEOUT_MS } from '../../../../vitest.timeouts';

/**
 * Release-gate guard for setup-cli.
 *
 * Many cases pay a fixed cost per test (real scrypt password hashing, files
 * written to temp dirs) that inflates under the root `ci:test` gate's full
 * parallelism. The config takes the shared budget for that; this reads the
 * configured budget rather than timing anything, so the guard itself is not
 * load-sensitive. The budget's sizing lives in vitest.timeouts.ts.
 */
describe('setup-cli vitest timeout budget', () => {
	const config = vitestConfig as ViteUserConfig;

	it('takes its budget from the shared root budget rather than a local literal', () => {
		expect(config.test?.testTimeout).toBe(PARALLEL_GATE_TIMEOUT_MS);
		expect(config.test?.hookTimeout).toBe(PARALLEL_GATE_TIMEOUT_MS);
	});
});
