import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The desktop boot plugin exposes the SPA router on `window.__NUXT_ROUTER__` so
// the native application menu (src-tauri `window::navigate_to`) can push routes
// client-side instead of forcing a full document reload. This is the one
// genuinely-new client branch of the router-nav piece; cover it directly.
//
// The plugin transitively pulls in the workspace store, keychain, deep-link and
// updater bridges — none relevant to the router exposure — so stub them all so
// the module imports cleanly and its `setup` runs without a real Tauri runtime.

const loadWorkspaces = vi.fn(async () => {});
vi.mock('~/composables/useDesktopWorkspaces', () => ({
	loadWorkspaces: (...args: unknown[]) => loadWorkspaces(...args),
}));

vi.mock('~/lib/desktop/activeWorkspace', () => ({
	isDesktopRuntime: () => true,
	getActiveWorkspace: () => null,
}));

const applyWorkspaceAccent = vi.fn();
vi.mock('~/lib/desktop/workspaceAccent', () => ({
	applyWorkspaceAccent: (...args: unknown[]) => applyWorkspaceAccent(...args),
}));

const showSwitchSkeleton = vi.fn(() => ({}) as unknown);
vi.mock('~/lib/desktop/workspaceSwitch', () => ({
	clearSwitchFlag: vi.fn(),
	hideSwitchSkeleton: vi.fn(),
	readSwitchFlag: () => null,
	showSwitchSkeleton: (...args: unknown[]) => showSwitchSkeleton(...args),
	SWITCH_FLAG_TTL_MS: 1000,
}));

const setupDeepLinks = vi.fn(async () => {});
vi.mock('~/lib/desktop/deepLink.client', () => ({
	setupDeepLinks: (...args: unknown[]) => setupDeepLinks(...args),
}));

const setupUpdateChecks = vi.fn();
vi.mock('~/lib/desktop/updater.client', () => ({
	setupUpdateChecks: (...args: unknown[]) => setupUpdateChecks(...args),
}));

vi.mock('@owlat/desktop/src/window', () => ({
	watchFullscreen: vi.fn(),
	setAccentFrameVisible: vi.fn(async () => {}),
}));

type BootPlugin = { setup: (nuxtApp: unknown) => Promise<void> };

async function loadBootPlugin(): Promise<BootPlugin> {
	// `defineNuxtPlugin` is a Nuxt global not present under vitest; stub it to the
	// identity so the default export is the plain plugin object we can drive.
	vi.stubGlobal('defineNuxtPlugin', (def: unknown) => def);
	const mod = await import('../0.desktop-workspace.client');
	return mod.default as unknown as BootPlugin;
}

describe('desktop boot plugin — SPA router exposure', () => {
	beforeEach(() => {
		loadWorkspaces.mockClear();
		delete (window as { __NUXT_ROUTER__?: unknown }).__NUXT_ROUTER__;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('exposes the SPA router on window.__NUXT_ROUTER__ so the native menu can push routes', async () => {
		const router = { push: vi.fn() };
		const nuxtApp = { $router: router, hook: vi.fn() };

		const plugin = await loadBootPlugin();
		await plugin.setup(nuxtApp);

		// This is the branch the native menu (`window::navigate_to`) reads before
		// falling back to a document-reloading location assignment.
		expect((window as { __NUXT_ROUTER__?: unknown }).__NUXT_ROUTER__).toBe(router);
	});

	it('still re-seeds the active workspace on boot (awaits loadWorkspaces before first render)', async () => {
		const nuxtApp = { $router: { push: vi.fn() }, hook: vi.fn() };

		const plugin = await loadBootPlugin();
		await plugin.setup(nuxtApp);

		// The workspace/keychain/singleton re-seed must run on desktop boot — the
		// router exposure must not have displaced it.
		expect(loadWorkspaces).toHaveBeenCalledTimes(1);
	});
});
