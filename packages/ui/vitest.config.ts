import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
	// SFC compilation, so the layer's components can be mounted against the real
	// `ui.*` catalogs (see __tests__/i18n.ts).
	plugins: [vue()],
	test: {
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json-summary', 'html'],
			reportsDirectory: './coverage',
			include: ['components/**/*.vue', 'composables/**/*.ts', 'utils/**/*.ts'],
			exclude: ['**/__tests__/**', '**/*.d.ts'],
			thresholds: { lines: 52 },
		},
		include: ['**/__tests__/**/*.test.ts'],
		exclude: ['node_modules', '.nuxt'],
		environment: 'happy-dom',
		setupFiles: ['vitest.setup.ts'],
	},
	resolve: {
		alias: [
			{
				find: /^@owlat\/shared\/(.+)$/,
				replacement: resolve(__dirname, '../shared/src/$1.ts'),
			},
			{
				find: '@owlat/shared',
				replacement: resolve(__dirname, '../shared/src/index.ts'),
			},
		],
	},
});
