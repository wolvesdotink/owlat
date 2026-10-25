/**
 * The real-browser component tests: `*.browser.test.ts` under
 * `app/__tests__/browser/`, run in Chrome through Vitest's browser mode.
 *
 *   bun run --cwd apps/web test:browser
 *
 * The unit suite (vitest.config.ts) defaults to happy-dom, which has no layout,
 * no native focus traversal and no ResizeObserver that ever fires. What depends on
 * those (a virtual list's window under real scrolling and resizing, a modal's
 * Tab trap, which layer a real Escape press reaches, a caret-anchored picker's
 * placement) is tested here, against the real composables and components.
 *
 * Keep this project small: every file costs CI time in a real browser. Logic
 * that a fabricated DOM proves just as well belongs in the unit suite.
 *
 * Chrome, not Playwright's bundled Chromium: the same channel the perf
 * scenarios run in, and the one already installed on a developer machine. CI
 * installs it explicitly (.github/workflows/test.yml, `test-web-browser`).
 */
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineBrowserCommand, playwright } from '@vitest/browser-playwright';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import unitConfig from './vitest.config';

/**
 * Vitest's browser API listens on one fixed port by default, so two worktrees
 * running this project at once collide. Each checkout gets its own port from a
 * hash of its path, in 61000-64999 (above Linux's ephemeral range); a port
 * that is still taken moves on rather than failing the run.
 */
function checkoutPort(path: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 0x01000193);
	return 61_000 + ((hash >>> 0) % 4_000);
}

/**
 * `import.meta.client` / `import.meta.server` as Nuxt's client bundle has
 * them. App code reads them to skip DOM work during server rendering
 * (`measureCaretRect` returns null without the client flag), and Vitest's
 * `define` does not reach `import.meta` properties in browser mode, so the
 * app's own sources get them rewritten instead. Dependencies never read them.
 */
function nuxtClientFlags(): Plugin {
	return {
		name: 'owlat:nuxt-client-flags',
		enforce: 'pre',
		transform(code, id) {
			if (id.includes('/node_modules/') || !/\bimport\.meta\.(client|server)\b/.test(code)) return;
			return {
				code: code
					.replace(/\bimport\.meta\.client\b/g, 'true')
					.replace(/\bimport\.meta\.server\b/g, 'false'),
				map: null,
			};
		},
	};
}

export default defineConfig({
	// The unit project's aliases (`~`, `~~`, `#components`, the workspace
	// sources) and its Vue plugin, so a browser test imports exactly the modules
	// a unit test does. Tailwind on top: layout is what these tests measure, and
	// it has to come from the app's real classes.
	plugins: [nuxtClientFlags(), ...(unitConfig.plugins ?? []), tailwindcss()],
	resolve: unitConfig.resolve,
	// Pre-bundled up front: a dependency Vite discovers mid-run reloads the page
	// under a running test.
	optimizeDeps: { include: ['convex/server', 'sanitize-html', 'tldts'] },
	test: {
		name: 'browser',
		include: ['app/__tests__/browser/**/*.browser.test.ts'],
		setupFiles: ['app/__tests__/browser/setup.ts'],
		browser: {
			enabled: true,
			headless: true,
			provider: playwright({ launchOptions: { channel: 'chrome' } }),
			instances: [{ browser: 'chromium' }],
			// The app's desktop breakpoint, so `lg:` classes resolve the way a
			// desktop window renders them.
			viewport: { width: 1280, height: 800 },
			// A failure's screenshot would land in the source tree.
			screenshotFailures: false,
			api: { port: checkoutPort(fileURLToPath(import.meta.url)), strictPort: false },
			commands: {
				// Playwright's mouse outlives each test, so whatever the next test
				// mounts under its last position starts hovered. The setup file parks
				// it off the page before every test.
				resetPointer: defineBrowserCommand(async ({ page }) => {
					await page.mouse.move(-1, -1);
				}),
			},
		},
	},
});
