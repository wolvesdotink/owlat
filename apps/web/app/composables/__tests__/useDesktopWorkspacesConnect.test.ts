import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorkspaceConfig, WorkspaceStoreShape } from '~/lib/desktop/workspaceTypes';

// The desktop connect handshake. These tests pin the invariant that broke a
// real connect: a handshake that does not end in a session must leave NOTHING
// behind. Persisting a half-connected workspace made the app show a server in
// the titlebar that the router then bounced straight back out of, with no error
// anywhere — "the server is added but nothing happens".

const saveWorkspaceStore = vi.fn<(store: WorkspaceStoreShape) => Promise<void>>();
const loadWorkspaceStore = vi.fn<() => Promise<WorkspaceStoreShape>>();
vi.mock('@owlat/desktop/src/workspace', () => ({
	saveWorkspaceStore: (store: WorkspaceStoreShape) => saveWorkspaceStore(store),
	loadWorkspaceStore: () => loadWorkspaceStore(),
}));

const secretSet = vi.fn(async () => {});
const secretDelete = vi.fn(async () => {});
vi.mock('@owlat/desktop/src/keychain', () => ({
	secretGet: vi.fn(async () => null),
	secretSet: (...a: unknown[]) => secretSet(...(a as [])),
	secretDelete: (...a: unknown[]) => secretDelete(...(a as [])),
}));

const openExternal = vi.fn(async () => {});
vi.mock('@owlat/desktop/src/shell', () => ({
	openExternal: (...a: unknown[]) => openExternal(...(a as [])),
}));

vi.mock('~/lib/desktop/activeWorkspace', () => ({
	isDesktopRuntime: () => true,
	setActiveWorkspace: vi.fn(),
}));

const configureKeychainStorage = vi.fn();
const resetKeychainStorage = vi.fn();
vi.mock('~/lib/desktop/keychainStorage', () => ({
	keychainStorage: {},
	configureKeychainStorage: (...a: unknown[]) => configureKeychainStorage(...a),
	clearKeychainStorage: vi.fn(),
	currentKeychainAccount: () => 'owlat-ws:already-active',
	resetKeychainStorage: (...a: unknown[]) => resetKeychainStorage(...a),
	snapshotKeychain: vi.fn(() => '{"prev":"blob"}'),
}));

vi.mock('~/lib/desktop/workspaceAccent', () => ({ applyWorkspaceAccent: vi.fn() }));
vi.mock('~/lib/desktop/workspaceSwitch', () => ({
	showSwitchSkeleton: vi.fn(() => ({})),
	hideSwitchSkeleton: vi.fn(),
	writeSwitchFlag: vi.fn(),
	clearSwitchFlag: vi.fn(),
	readSwitchFlag: vi.fn(() => null),
	SWITCH_FLAG_TTL_MS: 1000,
}));

// The redeem + session pair the handshake hangs on, driven per test.
const authFetch = vi.fn();
const getSession = vi.fn();
vi.mock('better-auth/vue', () => ({
	createAuthClient: () => ({
		$fetch: (...a: unknown[]) => authFetch(...a),
		getSession: () => getSession(),
	}),
}));
vi.mock('@convex-dev/better-auth/client/plugins', () => ({
	convexClient: () => ({}),
	crossDomainClient: () => ({}),
}));
vi.mock('better-auth/client/plugins', () => ({ organizationClient: () => ({}) }));

const INSTANCE = {
	name: 'acme',
	convexUrl: 'https://api.acme.test',
	convexSiteUrl: 'https://rest.api.acme.test',
	siteUrl: 'https://acme.test',
	deploymentMode: 'selfhost',
};

/**
 * A fresh copy of the modules under test. The workspace list is module-level
 * singleton state (lib/desktop/workspaceState.ts), so cases would otherwise leak
 * into each other. Both modules are imported after the SAME reset so they share
 * one module graph — and therefore one workspace list, as they do at runtime.
 */
async function freshModule() {
	vi.resetModules();
	const [composable, connect] = await Promise.all([
		import('../useDesktopWorkspaces'),
		import('~/lib/desktop/workspaceConnect'),
	]);
	return { ...composable, ...connect };
}

/** Run the browser half of the handshake and return the state nonce it minted. */
async function beginConnect(mod: Awaited<ReturnType<typeof freshModule>>): Promise<string> {
	await mod.useDesktopWorkspaces().addWorkspace('acme.test');
	const opened = new URL(openExternal.mock.calls.at(-1)?.[0] as string);
	return opened.searchParams.get('state') as string;
}

let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.clearAllMocks();
	window.localStorage.clear();
	vi.stubGlobal('useI18n', () => ({ t: (k: string) => k }));
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => ({ ok: true, json: async () => INSTANCE }) as unknown as Response)
	);
	assign = vi.fn();
	Object.defineProperty(window.location, 'assign', {
		value: assign,
		configurable: true,
		writable: true,
	});
	loadWorkspaceStore.mockResolvedValue({ workspaces: [], activeWorkspaceId: null });
	getSession.mockResolvedValue({ data: { user: { id: 'user-1' } } });
	authFetch.mockResolvedValue({ data: {}, error: null });
});

// NOTE: no `vi.unstubAllGlobals()` here. The shared setup file installs the
// Nuxt auto-imports (`ref`, `computed`, …) with `vi.stubGlobal`, so unstubbing
// globals would strip them and every later module eval would die on
// "ref is not defined" — a failure that looks like a source bug but is not.
afterEach(() => {
	vi.clearAllMocks();
});

describe('completeConnection — a failed handshake leaves nothing behind', () => {
	// BetterAuth's $fetch resolves (does not reject) on a non-2xx, so the error
	// arm is the only signal that the redeem failed. Missing it is what let a
	// 404 sail through and persist a signed-out workspace.
	it('throws and persists nothing when the redeem is rejected', async () => {
		const mod = await freshModule();
		await mod.loadWorkspaces();
		const state = await beginConnect(mod);
		saveWorkspaceStore.mockClear();
		authFetch.mockResolvedValue({ data: null, error: { status: 500, message: 'boom' } });

		await expect(mod.completeConnection({ ott: 'tok', state })).rejects.toThrow(
			'shared.useDesktopWorkspaces.errors.verifyFailed'
		);

		expect(saveWorkspaceStore).not.toHaveBeenCalled();
		expect(assign).not.toHaveBeenCalled();
	});

	// A 404 on /cross-domain/one-time-token/verify is not a bad token: the route
	// is absent, which is precisely what a pre-v0.4.14 server looks like. The
	// generic "sign-in failed" sent the user hunting for the wrong problem.
	it('names an outdated server when the verify route is missing', async () => {
		const mod = await freshModule();
		await mod.loadWorkspaces();
		const state = await beginConnect(mod);
		authFetch.mockResolvedValue({ data: null, error: { status: 404 } });

		await expect(mod.completeConnection({ ott: 'tok', state })).rejects.toThrow(
			'shared.useDesktopWorkspaces.errors.verifyRouteMissing'
		);
	});

	// The exact shape of the bug in the wild: redeem "succeeds", no session
	// comes back, and the workspace was stored with an empty userId anyway.
	it('throws rather than storing a workspace with no user', async () => {
		const mod = await freshModule();
		await mod.loadWorkspaces();
		const state = await beginConnect(mod);
		saveWorkspaceStore.mockClear();
		getSession.mockResolvedValue({ data: null });

		await expect(mod.completeConnection({ ott: 'tok', state })).rejects.toThrow(
			'shared.useDesktopWorkspaces.errors.noSession'
		);

		expect(saveWorkspaceStore).not.toHaveBeenCalled();
	});

	// Re-pointing the single global keychain cache is destructive. A failed
	// handshake must put it back, or the ACTIVE workspace's session writes land
	// in the abandoned workspace's keychain entry.
	it('restores the previous keychain binding and drops the abandoned entry', async () => {
		const mod = await freshModule();
		await mod.loadWorkspaces();
		const state = await beginConnect(mod);
		configureKeychainStorage.mockClear();
		authFetch.mockResolvedValue({ data: null, error: { status: 404 } });

		await expect(mod.completeConnection({ ott: 'tok', state })).rejects.toThrow();

		// Last configure puts the cache back on the previously-bound account.
		expect(configureKeychainStorage.mock.calls.at(-1)?.slice(0, 2)).toEqual([
			'owlat-ws:already-active',
			'{"prev":"blob"}',
		]);
		// ...and on disk too. A handshake runs far longer than the write-through
		// debounce, so the flush has very likely already overwritten the
		// previously-active workspace's entry with the failed attempt's cache.
		expect(secretSet).toHaveBeenCalledWith('owlat-ws:already-active', '{"prev":"blob"}');
		// And the entry minted for the abandoned workspace is removed.
		expect(secretDelete).toHaveBeenCalledTimes(1);
		expect(String(secretDelete.mock.calls[0]?.[0])).toMatch(/^owlat-ws:/);
		expect(secretDelete).not.toHaveBeenCalledWith('owlat-ws:already-active');
	});

	// A re-auth of an already-connected server reuses its id, so its keychain
	// entry is the workspace's own — deleting it on a failed retry would sign
	// the user out of a workspace that is still in the list.
	it('keeps the keychain entry of a workspace it was re-authenticating', async () => {
		loadWorkspaceStore.mockResolvedValue({
			workspaces: [
				{
					id: 'ws-existing',
					label: 'acme',
					siteUrl: 'https://acme.test',
					convexUrl: 'https://api.acme.test',
					convexSiteUrl: 'https://rest.api.acme.test',
					userId: 'user-1',
					tokenRef: 'owlat-ws:ws-existing',
					addedAt: 1,
					lastActiveAt: 1,
					accentColor: '#8c5a7a',
				} satisfies WorkspaceConfig,
			],
			activeWorkspaceId: 'ws-existing',
		});

		const mod = await freshModule();
		await mod.loadWorkspaces();
		const state = await beginConnect(mod);
		authFetch.mockResolvedValue({ data: null, error: { status: 404 } });

		await expect(mod.completeConnection({ ott: 'tok', state })).rejects.toThrow();

		expect(secretDelete).not.toHaveBeenCalled();
	});
});

describe('completeConnection — the happy path', () => {
	it('persists the signed-in workspace and reloads into it', async () => {
		const mod = await freshModule();
		await mod.loadWorkspaces();
		const state = await beginConnect(mod);
		saveWorkspaceStore.mockClear();

		await mod.completeConnection({ ott: 'tok', state });

		const persisted = saveWorkspaceStore.mock.calls.at(-1)?.[0] as WorkspaceStoreShape;
		expect(persisted.workspaces).toHaveLength(1);
		expect(persisted.workspaces[0]).toMatchObject({
			userId: 'user-1',
			siteUrl: 'https://acme.test',
		});
		expect(persisted.activeWorkspaceId).toBe(persisted.workspaces[0]?.id);
		expect(secretSet).toHaveBeenCalled();
		expect(assign).toHaveBeenCalledWith('/dashboard');
	});

	// The cold-start path: macOS launches the app to deliver owlat://auth, so
	// the process completing the handshake never ran addWorkspace. Resolving the
	// nonce from durable storage is what makes that work at all.
	it('completes a handshake begun by a previous process', async () => {
		const first = await freshModule();
		await first.loadWorkspaces();
		const state = await beginConnect(first);

		// A brand-new process: fresh module state, same localStorage.
		const relaunched = await freshModule();
		await relaunched.loadWorkspaces();
		saveWorkspaceStore.mockClear();

		await relaunched.completeConnection({ ott: 'tok', state });

		const persisted = saveWorkspaceStore.mock.calls.at(-1)?.[0] as WorkspaceStoreShape;
		expect(persisted.workspaces).toHaveLength(1);
		expect(persisted.workspaces[0]?.userId).toBe('user-1');
	});

	it('rejects a state nonce that was never issued', async () => {
		const mod = await freshModule();
		await mod.loadWorkspaces();

		await expect(mod.completeConnection({ ott: 'tok', state: 'never-issued' })).rejects.toThrow(
			'shared.useDesktopWorkspaces.errors.stateMismatch'
		);
	});
});

describe('addWorkspace — reconnecting an existing server', () => {
	// Every retry used to mint a fresh uuid, so repairing a dead session left a
	// duplicate row per attempt and the broken one still in the list.
	it('re-authenticates in place instead of adding a second entry', async () => {
		const existing: WorkspaceConfig = {
			id: 'ws-existing',
			label: 'acme',
			siteUrl: 'https://acme.test',
			convexUrl: 'https://api.acme.test',
			convexSiteUrl: 'https://rest.api.acme.test',
			userId: '',
			tokenRef: 'owlat-ws:ws-existing',
			addedAt: 1,
			lastActiveAt: 1,
			accentColor: '#8c5a7a',
		};
		loadWorkspaceStore.mockResolvedValue({
			workspaces: [existing],
			activeWorkspaceId: 'ws-existing',
		});

		const mod = await freshModule();
		await mod.loadWorkspaces();
		const state = await beginConnect(mod);
		saveWorkspaceStore.mockClear();

		await mod.completeConnection({ ott: 'tok', state });

		const persisted = saveWorkspaceStore.mock.calls.at(-1)?.[0] as WorkspaceStoreShape;
		expect(persisted.workspaces).toHaveLength(1);
		expect(persisted.workspaces[0]).toMatchObject({
			id: 'ws-existing',
			userId: 'user-1',
			// A user-chosen accent and the original add date survive the re-auth.
			accentColor: '#8c5a7a',
			addedAt: 1,
		});
	});
});
