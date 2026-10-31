import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { PARALLEL_GATE_TIMEOUT_MS } from '../../../vitest.timeouts';

export default defineConfig({
	test: {
		include: ['src/**/__tests__/**/*.test.ts'],
		environment: 'node',
		// The scanner-cap suite analyzes an adversarial body whose capped prefix is
		// still the worst case for the tag regex: a few seconds on an idle machine,
		// and over 45s once the release gate runs every workspace on one runner.
		// The cap itself is proven by equality with the capped prefix, not by time.
		testTimeout: PARALLEL_GATE_TIMEOUT_MS,
		hookTimeout: PARALLEL_GATE_TIMEOUT_MS,
	},
	resolve: {
		alias: {
			'@owlat/plugin-kit': resolve(__dirname, '../../../packages/plugin-kit/src/index.ts'),
			'@owlat/provider-kit': resolve(__dirname, '../../../packages/provider-kit/src/index.ts'),
		},
	},
});
