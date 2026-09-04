/**
 * `desktop-workspace.global` pre-auth gate over the shipped
 * `useDesktopWorkspaces` (its workspace store and keychain bridges mocked at
 * the Tauri boundary) and the real vue-i18n `useI18n`.
 *
 * The packaged Tauri app loads `/` on every launch, and `/` is also the web
 * marketing landing: the desktop runtime must be routed into the product —
 * `/desktop/welcome` with no workspace, `/dashboard` with one (regression:
 * desktop-v0.3.1 booted to the marketing page with a connected workspace and
 * no way to switch).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteLocationNormalized } from 'vue-router';
import type { WorkspaceConfig, WorkspaceStoreShape } from '~/lib/desktop/workspaceTypes';
import {
	authClientMock,
	enterDesktopRuntime,
	leaveDesktopRuntime,
	loadMiddleware,
	route,
	type Redirect,
} from './harness';

vi.mock('~/lib/auth-client', () => authClientMock());

const loadWorkspaceStore = vi.fn<() => Promise<WorkspaceStoreShape>>();
vi.mock('@owlat/desktop/src/workspace', () => ({
	saveWorkspaceStore: vi.fn(async () => undefined),
	loadWorkspaceStore: () => loadWorkspaceStore(),
}));
vi.mock('@owlat/desktop/src/keychain', () => ({
	secretGet: vi.fn(async () => 'session-blob'),
	secretSet: vi.fn(async () => undefined),
	secretDelete: vi.fn(async () => undefined),
}));
vi.mock('~/lib/desktop/keychainStorage', () => ({
	keychainStorage: {},
	configureKeychainStorage: vi.fn(),
	clearKeychainStorage: vi.fn(),
	snapshotKeychain: vi.fn(() => ''),
}));
vi.mock('~/lib/desktop/workspaceAccent', () => ({ applyWorkspaceAccent: vi.fn() }));
vi.mock('~/lib/desktop/workspaceSwitch', () => ({
	showSwitchSkeleton: vi.fn(() => ({})),
	hideSwitchSkeleton: vi.fn(),
	writeSwitchFlag: vi.fn(),
	SWITCH_FLAG_TTL_MS: 1000,
}));

type Middleware = (
	to: RouteLocationNormalized,
	from: RouteLocationNormalized
) => Redirect | undefined;

const WORKSPACE = {
	id: 'ws-1',
	label: 'Acme',
	siteUrl: 'https://acme.example',
	convexUrl: 'https://acme.convex.cloud',
	convexSiteUrl: 'https://acme.convex.site',
	userId: 'user-1',
	tokenRef: 'owlat-ws:ws-1',
	accentColor: '#3366ff',
} as unknown as WorkspaceConfig;

/** Load the guard with the desktop store holding `workspaces`, `active` selected. */
async function load(store: { workspaces: WorkspaceConfig[]; active: string | null }) {
	loadWorkspaceStore.mockResolvedValue({
		workspaces: store.workspaces,
		activeWorkspaceId: store.active,
	});
	return loadMiddleware<Middleware>(async () => {
		const desktop = await import('~/composables/useDesktopWorkspaces');
		vi.stubGlobal('useDesktopWorkspaces', desktop.useDesktopWorkspaces);
		await desktop.loadWorkspaces();
		return import('../desktop-workspace.global');
	});
}

beforeEach(enterDesktopRuntime);
afterEach(leaveDesktopRuntime);

describe('desktop-workspace middleware', () => {
	it('is a no-op outside the desktop runtime (web keeps its landing page)', async () => {
		leaveDesktopRuntime();
		const { middleware } = await load({ workspaces: [], active: null });
		const to = route('/');

		expect(middleware(to, to)).toBeUndefined();
	});

	it('routes to the welcome screen when no workspace is active', async () => {
		const { middleware } = await load({ workspaces: [], active: null });
		const to = route('/');

		expect(middleware(to, to)).toEqual({ redirect: '/desktop/welcome', options: undefined });
	});

	it('routes the entry document into the product when a workspace is active', async () => {
		const { middleware } = await load({ workspaces: [WORKSPACE], active: WORKSPACE.id });
		const to = route('/');

		expect(middleware(to, to)).toEqual({ redirect: '/dashboard', options: undefined });
	});

	it('leaves in-app routes alone when a workspace is active', async () => {
		const { middleware } = await load({ workspaces: [WORKSPACE], active: WORKSPACE.id });

		for (const path of ['/dashboard/inbox', '/terms']) {
			const to = route(path);
			expect(middleware(to, to)).toBeUndefined();
		}
	});

	it('never re-routes the desktop connect/welcome/setup/settings screens themselves', async () => {
		const { middleware } = await load({ workspaces: [], active: null });

		for (const path of [
			'/desktop/welcome',
			'/desktop/connect',
			'/desktop/setup',
			'/desktop/settings',
		]) {
			const to = route(path);
			expect(middleware(to, to)).toBeUndefined();
		}
	});
});
