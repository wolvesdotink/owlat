import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
	plugins: [vue()],
	test: {
		include: ['app/**/__tests__/**/*.test.ts', 'server/**/__tests__/**/*.test.ts'],
		environment: 'happy-dom',
		setupFiles: ['app/__tests__/setup.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json-summary', 'html'],
			reportsDirectory: './coverage',
			include: ['app/composables/**/*.ts', 'app/utils/**/*.ts'],
			exclude: ['app/**/__tests__/**'],
			thresholds: {
				lines: 20,
			},
		},
	},
	resolve: {
		alias: [
			// `~~` (Nuxt rootDir) must precede `~` — string aliases match in order,
			// and `~` would otherwise swallow the `~~/server/...` imports used by
			// server routes under test.
			{ find: '~~', replacement: resolve(__dirname, '.') },
			{ find: '~', replacement: resolve(__dirname, 'app') },
			{
				// Subpath exports are a mix of `src/<name>.ts` and `src/<name>/index.ts`
				// (e.g. `@owlat/shared/registry`), so the replacement stops at the
				// stem and lets Vite's extension/index resolution finish the job.
				find: /^@owlat\/shared\/(.+)$/,
				replacement: resolve(__dirname, '../../packages/shared/src/$1'),
			},
			{
				find: '@owlat/shared',
				replacement: resolve(__dirname, '../../packages/shared/src/index.ts'),
			},
			{
				find: '@owlat/plugin-host',
				replacement: resolve(__dirname, '../../packages/plugin-host/src/index.ts'),
			},
			{
				find: '@owlat/plugin-kit',
				replacement: resolve(__dirname, '../../packages/plugin-kit/src/index.ts'),
			},
			{
				find: '@owlat/provider-kit',
				replacement: resolve(__dirname, '../../packages/provider-kit/src/index.ts'),
			},
		],
	},
});
