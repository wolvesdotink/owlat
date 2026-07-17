/**
 * Unit tests for the desktop pre-auth gate in `desktop-workspace.global.ts`.
 *
 * The packaged Tauri app loads `/` (the frontendDist entry document) on every
 * launch, and `/` is also the web marketing landing. The middleware must route
 * the desktop runtime into the product: `/desktop/welcome` when no workspace
 * is active, `/dashboard` when one is — the landing renders inside the shell
 * with no workspace rail/switcher otherwise (regression: desktop-v0.3.1 booted
 * to the marketing page with a connected workspace and no way to switch).
 *
 * The middleware module calls `defineNuxtRouteMiddleware` at import time and
 * relies on the `navigateTo` / `useDesktopWorkspaces` auto-imports, so we stub
 * those globals before importing the file.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';

const navigateTo = vi.fn((path: string) => path);
vi.stubGlobal('defineNuxtRouteMiddleware', (fn: unknown) => fn);
vi.stubGlobal('navigateTo', navigateTo);

const active = ref<{ id: string } | null>(null);
vi.stubGlobal('useDesktopWorkspaces', () => ({ active }));

const isDesktopRuntime = vi.fn(() => true);
vi.mock('~/lib/desktop/activeWorkspace', () => ({
	isDesktopRuntime: () => isDesktopRuntime(),
}));

type Middleware = (to: { path: string }) => unknown;
const middleware = (await import('../desktop-workspace.global')).default as Middleware;

describe('desktop-workspace.global — desktop entry routing', () => {
	beforeEach(() => {
		navigateTo.mockClear();
		isDesktopRuntime.mockReturnValue(true);
		active.value = null;
	});

	it('is a no-op outside the desktop runtime (web keeps its landing page)', () => {
		isDesktopRuntime.mockReturnValue(false);
		expect(middleware({ path: '/' })).toBeUndefined();
		expect(navigateTo).not.toHaveBeenCalled();
	});

	it('routes to the welcome screen when no workspace is active', () => {
		middleware({ path: '/' });
		expect(navigateTo).toHaveBeenCalledWith('/desktop/welcome');
	});

	it('routes the entry document to the dashboard when a workspace is active', () => {
		active.value = { id: 'ws-1' };
		middleware({ path: '/' });
		expect(navigateTo).toHaveBeenCalledWith('/dashboard');
	});

	it('leaves non-entry routes alone when a workspace is active', () => {
		active.value = { id: 'ws-1' };
		expect(middleware({ path: '/dashboard/inbox' })).toBeUndefined();
		expect(middleware({ path: '/terms' })).toBeUndefined();
		expect(navigateTo).not.toHaveBeenCalled();
	});

	it('never re-routes the desktop connect/welcome/setup screens themselves', () => {
		for (const path of ['/desktop/welcome', '/desktop/connect', '/desktop/setup']) {
			expect(middleware({ path })).toBeUndefined();
		}
		expect(navigateTo).not.toHaveBeenCalled();
	});

	it('lets the settings surface through with no active workspace (native menu entry)', () => {
		// Regression: the menu's Settings item was a silent no-op pre-connection;
		// /desktop/settings must be reachable without a workspace or session.
		expect(middleware({ path: '/desktop/settings' })).toBeUndefined();
		expect(navigateTo).not.toHaveBeenCalled();
	});
});
