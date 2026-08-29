import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import vue from '@vitejs/plugin-vue';
import { PARALLEL_GATE_TIMEOUT_MS } from '../../vitest.timeouts';

export default defineConfig({
	plugins: [vue()],
	test: {
		include: ['app/**/__tests__/**/*.test.ts', 'server/**/__tests__/**/*.test.ts'],
		environment: 'happy-dom',
		setupFiles: ['app/__tests__/setup.ts'],
		// Composable specs reload the composable under test with `vi.resetModules()`
		// + a dynamic `import()` INSIDE the case, because the Nuxt auto-import stubs
		// have to be installed before the module graph is evaluated. Transforming
		// that graph is milliseconds on an idle machine and seconds once the root
		// `ci:test` gate runs every turbo test task at once — which blew vitest's
		// 5000ms default and failed the gate on machine load rather than on code.
		// Asserted by app/__tests__/vitestTimeout.test.ts.
		testTimeout: PARALLEL_GATE_TIMEOUT_MS,
		hookTimeout: PARALLEL_GATE_TIMEOUT_MS,
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
