/**
 * Production build of the component scenario fixture (perf/fixture).
 *
 * The same compilers the app ships through (the Vue SFC plugin and Tailwind
 * over the app's own stylesheet), minified, with Vue's production runtime, so
 * a scenario measures the components as users run them. It is not the Nuxt app:
 * there is no router, no Convex client and no auth, which is the point.
 */
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

const web = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
	root: fileURLToPath(new URL('./fixture', import.meta.url)),
	base: './',
	logLevel: 'warn',
	plugins: [vue(), tailwindcss()],
	define: {
		// What Nuxt defines for the client bundle, read by app code the components import.
		'import.meta.client': 'true',
		'import.meta.server': 'false',
		'import.meta.dev': 'false',
		__VUE_I18N_FULL_INSTALL__: 'true',
		__VUE_I18N_LEGACY_API__: 'false',
		__INTLIFY_PROD_DEVTOOLS__: 'false',
	},
	resolve: {
		alias: [
			// `~~` before `~`: string aliases match in order (as in vitest.config.ts).
			{ find: '~~', replacement: web },
			{ find: '~', replacement: `${web}app` },
			// Nuxt's virtual component module; rows import `NuxtLink` from it.
			{ find: '#components', replacement: `${web}perf/fixture/nuxtComponents.ts` },
		],
	},
	build: {
		// Outside the source tree, ignored by git with the rest of node_modules.
		outDir: `${web}node_modules/.cache/owlat-perf/fixture`,
		emptyOutDir: true,
		target: 'es2022',
		// The app catalog alone is ~800 kB; one chunk keeps the load a single request.
		chunkSizeWarningLimit: 4096,
	},
});
