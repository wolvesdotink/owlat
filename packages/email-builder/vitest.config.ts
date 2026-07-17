import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

export default defineConfig({
	plugins: [vue()],
	test: {
		include: ['src/**/__tests__/**/*.test.ts'],
		environment: 'node',
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
