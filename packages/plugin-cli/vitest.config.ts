import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { PARALLEL_GATE_TIMEOUT_MS } from '../../vitest.timeouts';

export default defineConfig({
	test: {
		include: ['src/**/__tests__/**/*.test.ts'],
		environment: 'node',
		// Every CLI test materialises a throwaway workspace and drives the real
		// codegen over it. That fixed cost is well under a second in isolation but
		// multiplies once the root `ci:test` gate runs all turbo test tasks at once,
		// which blew vitest's 5000ms default and made the release gate flake. Size
		// the budget for the contended run, not for an idle machine. Asserted by
		// src/__tests__/vitestTimeout.test.ts.
		testTimeout: PARALLEL_GATE_TIMEOUT_MS,
		hookTimeout: PARALLEL_GATE_TIMEOUT_MS,
	},
	resolve: {
		alias: {
			'@owlat/plugin-codegen': resolve(__dirname, '../plugin-codegen/src/index.ts'),
			'@owlat/plugin-host': resolve(__dirname, '../plugin-host/src/index.ts'),
			'@owlat/plugin-kit': resolve(__dirname, '../plugin-kit/src/index.ts'),
		},
	},
});
