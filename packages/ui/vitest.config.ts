import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
	test: {
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
