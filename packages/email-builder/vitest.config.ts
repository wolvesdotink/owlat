import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

export default defineConfig({
	plugins: [vue()],
	test: {
		include: ['src/**/__tests__/**/*.test.ts'],
		environment: 'node',
		// The email-block host tests deliberately reload the whole module graph
		// (`vi.resetModules()` + dynamic import) on every test, because the block
		// registries are module-level one-way latches. That fixed setup cost is
		// milliseconds in isolation but seconds once the root `ci:test` gate runs all
		// turbo test tasks in parallel, which blew vitest's 5000ms default and made
		// the release gate flake. Size the budget for the reload, not for an idle
		// machine. Asserted by src/__tests__/vitestTimeout.test.ts.
		testTimeout: 20000,
		hookTimeout: 20000,
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json-summary', 'html'],
			reportsDirectory: './coverage',
			include: ['src/**/*.ts'],
			exclude: ['src/**/__tests__/**'],
			thresholds: {
				lines: 20,
			},
		},
	},
	resolve: {
		alias: {
			'@': resolve(__dirname, 'src'),
			// @owlat/plugin-kit ships a built `dist` entry; resolve it to source in
			// tests so the host composition can import it without a prior build.
			'@owlat/plugin-kit': resolve(__dirname, '../plugin-kit/src/index.ts'),
		},
	},
});
