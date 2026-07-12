import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorkspaceConfig, WorkspaceStoreShape } from '~/lib/desktop/workspaceTypes';

// Dev-only auto-connect: under `tauri dev` the webview loads the local Nuxt dev
// server, so loadWorkspaces({ seedLocalDev: true }) must upsert a workspace for
// the page's own origin (discovered via /api/instance-info) instead of sending
// the developer through the manual connect handshake. These tests pin the
// upsert semantics: deterministic id (stable keychain ref across store wipes),
// no duplicates when a matching workspace exists, fail-soft on probe errors,
// and no probe at all when the flag is off (packaged builds).

const saveWorkspaceStore = vi.fn<(store: WorkspaceStoreShape) => Promise<void>>(async () => {});
const loadWorkspaceStore = vi.fn<() => Promise<WorkspaceStoreShape>>();
vi.mock('@owlat/desktop/src/workspace', () => ({
	saveWorkspaceStore: (store: WorkspaceStoreShape) => saveWorkspaceStore(store),
	loadWorkspaceStore: () => loadWorkspaceStore(),
}));

const secretGet = vi.fn(async () => 'session-blob');
vi.mock('@owlat/desktop/src/keychain', () => ({
	secretGet: (...args: unknown[]) => secretGet(...(args as [])),
	secretSet: vi.fn(async () => {}),
	secretDelete: vi.fn(async () => {}),
}));

const setActiveWorkspace = vi.fn();
vi.mock('~/lib/desktop/activeWorkspace', () => ({
	isDesktopRuntime: () => true,
	setActiveWorkspace: (...args: unknown[]) => setActiveWorkspace(...args),
}));

const configureKeychainStorage = vi.fn();
vi.mock('~/lib/desktop/keychainStorage', () => ({
	keychainStorage: {},
	configureKeychainStorage: (...args: unknown[]) => configureKeychainStorage(...args),
	clearKeychainStorage: vi.fn(),
	snapshotKeychain: vi.fn(() => ''),
}));

vi.mock('~/lib/desktop/workspaceAccent', () => ({
	applyWorkspaceAccent: vi.fn(),
}));

vi.mock('~/lib/desktop/workspaceSwitch', () => ({
	showSwitchSkeleton: vi.fn(() => ({})),
	hideSwitchSkeleton: vi.fn(),
	writeSwitchFlag: vi.fn(),
	SWITCH_FLAG_TTL_MS: 1000,
}));

const INSTANCE_INFO = {
	name: 'Owlat Dev',
	convexUrl: 'http://127.0.0.1:3210',
	convexSiteUrl: 'http://localhost:3211',
	siteUrl: 'http://localhost:3000',
	deploymentMode: 'selfhost',
};

const fetchMock = vi.fn();

function mockInstanceInfo(info: typeof INSTANCE_INFO = INSTANCE_INFO) {
	fetchMock.mockResolvedValue({
		ok: true,
		json: async () => info,
	} as unknown as Response);
}

// The composable keeps module-level state behind a load-once guard, so each
// case re-imports a fresh module instance.
async function importFresh() {
	vi.resetModules();
	return import('../useDesktopWorkspaces');
}

function manualLocalWorkspace(): WorkspaceConfig {
	return {
		id: 'manually-added-uuid',
		label: 'My Dev Server',
		siteUrl: 'http://localhost:3000',
		convexUrl: 'http://127.0.0.1:9999',
		convexSiteUrl: 'http://localhost:9998',
		userId: 'user-1',
		tokenRef: 'owlat-ws:manually-added-uuid',
		addedAt: 1,
		lastActiveAt: 1,
		accentColor: '#7a8c5a',
	};
}

describe('loadWorkspaces seedLocalDev — dev auto-connect to the local instance', () => {
	// Swap fetch by assignment, NOT vi.stubGlobal/unstubAllGlobals — the vitest
	// setup file polyfills Nuxt auto-imports (ref, computed, …) as stubbed
	// globals, and unstubAllGlobals would wipe those too.
	const realFetch = globalThis.fetch;

	beforeEach(() => {
		saveWorkspaceStore.mockClear();
		setActiveWorkspace.mockClear();
		configureKeychainStorage.mockClear();
		fetchMock.mockReset();
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		// happy-dom's default origin already matches, but pin it so the test does
		// not silently skip the seed path if the environment origin ever changes.
		Object.defineProperty(window.location, 'origin', {
			value: 'http://localhost:3000',
			configurable: true,
		});
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it('seeds a deterministic local-dev workspace on a fresh profile and activates it', async () => {
		mockInstanceInfo();
		loadWorkspaceStore.mockResolvedValue({ workspaces: [], activeWorkspaceId: null });
		const { loadWorkspaces, LOCAL_DEV_WORKSPACE_ID, useDesktopWorkspaces } = await importFresh();

		await loadWorkspaces({ seedLocalDev: true });

		const { active } = useDesktopWorkspaces();
		expect(active.value?.id).toBe(LOCAL_DEV_WORKSPACE_ID);
		expect(active.value?.convexUrl).toBe(INSTANCE_INFO.convexUrl);
		expect(active.value?.convexSiteUrl).toBe(INSTANCE_INFO.convexSiteUrl);
		// The deterministic keychain ref is the whole point of the stable id: a
		// dev session stored before a workspaces.json wipe signs back in.
		expect(active.value?.tokenRef).toBe(`owlat-ws:${LOCAL_DEV_WORKSPACE_ID}`);

		// Persisted, seeded as the active-workspace singleton, keychain hydrated.
		const persisted = saveWorkspaceStore.mock.calls.at(-1)?.[0] as WorkspaceStoreShape;
		expect(persisted.activeWorkspaceId).toBe(LOCAL_DEV_WORKSPACE_ID);
		expect(setActiveWorkspace).toHaveBeenCalledWith(
			expect.objectContaining({ id: LOCAL_DEV_WORKSPACE_ID })
		);
		expect(configureKeychainStorage).toHaveBeenCalledWith(
			`owlat-ws:${LOCAL_DEV_WORKSPACE_ID}`,
			'session-blob',
			expect.any(Function)
		);
	});

	it('reuses a manually-connected workspace on the same origin and refreshes its endpoints', async () => {
		mockInstanceInfo();
		const manual = manualLocalWorkspace();
		loadWorkspaceStore.mockResolvedValue({
			workspaces: [manual],
			activeWorkspaceId: manual.id,
		});
		const { loadWorkspaces, useDesktopWorkspaces } = await importFresh();

		await loadWorkspaces({ seedLocalDev: true });

		const { workspaces, active } = useDesktopWorkspaces();
		expect(workspaces.value).toHaveLength(1);
		expect(active.value?.id).toBe(manual.id);
		// Stale local Convex endpoints are refreshed from the live instance.
		expect(active.value?.convexUrl).toBe(INSTANCE_INFO.convexUrl);
		expect(active.value?.convexSiteUrl).toBe(INSTANCE_INFO.convexSiteUrl);
	});

	it('fails soft when the instance probe errors — no workspace, welcome flow takes over', async () => {
		fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
		loadWorkspaceStore.mockResolvedValue({ workspaces: [], activeWorkspaceId: null });
		const { loadWorkspaces, useDesktopWorkspaces } = await importFresh();

		await loadWorkspaces({ seedLocalDev: true });

		expect(useDesktopWorkspaces().active.value).toBeNull();
		expect(setActiveWorkspace).toHaveBeenCalledWith(null);
	});

	it('does not probe at all without the flag (packaged builds)', async () => {
		loadWorkspaceStore.mockResolvedValue({ workspaces: [], activeWorkspaceId: null });
		const { loadWorkspaces } = await importFresh();

		await loadWorkspaces();

		expect(fetchMock).not.toHaveBeenCalled();
	});
});
