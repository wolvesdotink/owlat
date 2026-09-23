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
		testTimeout: PARALLEL_GATE_TIMEOUT_MS,
		hookTimeout: PARALLEL_GATE_TIMEOUT_MS,
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json-summary', 'html'],
			reportsDirectory: './coverage',
			// The denominator is the whole app, Vue surfaces and Nitro server included,
			// so a file nobody tests still counts against the total instead of
			// dropping out of it.
			include: ['app/**/*.{ts,vue}', 'server/**/*.ts'],
			exclude: ['**/__tests__/**', '**/*.d.ts', '**/*.generated.ts', 'app/generated/**'],
			// Floors, not targets: each sits a point or two under what the suite
			// measured when it was set (2026-09-23), so real erosion fails the run
			// while ordinary churn does not. Raise one when its path's coverage
			// climbs; lowering one needs a reason in the commit.
			//
			// The global floor is mostly Vue components and pages, where coverage is
			// thin. The per-path floors hold the risky code to a higher bar: the Nitro
			// server (auth proxy, setup, self-update, transport apply), app/lib (CSRF,
			// auth client, command palette, desktop lifecycle), the desktop updater
			// and workspace lifecycle on its own, and the route guards. A glob's
			// floor is checked on its own files; the global floor still counts them.
			// Threshold globs skip dot segments, so the server key names
			// `routes/.well-known/` explicitly or those routes would count only
			// toward the global floor.
			thresholds: {
				lines: 50,
				statements: 49,
				functions: 41,
				branches: 43,
				'server/{**,routes/.well-known/**}': {
					lines: 69,
					statements: 68,
					functions: 68,
					branches: 59,
				},
				'app/lib/**': { lines: 90, statements: 89, functions: 86, branches: 86 },
				'app/lib/desktop/**': { lines: 89, statements: 87, functions: 77, branches: 85 },
				'app/middleware/**': { lines: 95, statements: 90, functions: 95, branches: 87 },
				'app/utils/**': { lines: 93, statements: 92, functions: 93, branches: 87 },
				'app/composables/**': { lines: 58, statements: 56, functions: 49, branches: 48 },
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
			// Nuxt's virtual component module — see app/__tests__/shims/nuxtComponents.ts.
			{
				find: '#components',
				replacement: resolve(__dirname, 'app/__tests__/shims/nuxtComponents.ts'),
			},
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
