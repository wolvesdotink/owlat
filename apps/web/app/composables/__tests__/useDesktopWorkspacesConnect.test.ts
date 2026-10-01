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

const secretGet = vi.fn(async (..._a: unknown[]): Promise<string | null> => null);
const secretSet = vi.fn(async (..._a: unknown[]) => {});
const secretDelete = vi.fn(async (..._a: unknown[]) => {});
vi.mock('@owlat/desktop/src/keychain', () => ({
	secretGet: (...a: unknown[]) => secretGet(...a),
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
vi.mock('better-auth/client/plugins', () => ({
	organizationClient: () => ({}),
	twoFactorClient: () => ({}),
}));

const INSTANCE = {
	name: 'acme',
	convexUrl: 'https://api.acme.test',
	convexSiteUrl: 'https://rest.api.acme.test',
	siteUrl: 'https://acme.test',
	deploymentMode: 'selfhost',
};

function workspaceConfig(id: string, siteUrl: string): WorkspaceConfig {
	return {
		id,
		label: id,
		siteUrl,
		convexUrl: `${siteUrl}/convex`,
		convexSiteUrl: `${siteUrl}/site`,
		userId: 'user-1',
		tokenRef: `owlat-ws:${id}`,
		addedAt: 1,
		lastActiveAt: 1,
		accentColor: '#8c5a7a',
	};
}

/**
 * A fresh copy of the modules under test. The workspace list is module-level
 * singleton state (lib/desktop/workspaceState.ts), so cases would otherwise leak
 * into each other. Both modules are imported after the SAME reset so they share
 * one module graph — and therefore one workspace list, as they do at runtime.
 */
async function freshModule() {
	vi.resetModules();
	const [composable, connect, storage] = await Promise.all([
		import('../useDesktopWorkspaces'),
		import('~/lib/desktop/workspaceConnect'),
		import('~/lib/desktop/keychainStorage'),
	]);
	return { ...composable, ...connect, ...storage };
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
	saveWorkspaceStore.mockResolvedValue(undefined);
	secretGet.mockResolvedValue(null);
	secretSet.mockResolvedValue(undefined);
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

	// The workspace this window is signed in to keeps its own storage while a
	// handshake runs: a failed handshake has nothing of it to put back, and
	// nothing of its own on disk to clean up.
	it("leaves the active workspace's session and every keychain entry untouched", async () => {
		loadWorkspaceStore.mockResolvedValue({
			workspaces: [workspaceConfig('ws-active', 'https://active.test')],
			activeWorkspaceId: 'ws-active',
		});
		secretGet.mockResolvedValue('{"better-auth_cookie":"active"}');
		const mod = await freshModule();
		await mod.loadWorkspaces();
		const active = mod.getActiveKeychainStorage();
		const state = await beginConnect(mod);
		authFetch.mockResolvedValue({ data: null, error: { status: 404 } });

		await expect(mod.completeConnection({ ott: 'tok', state })).rejects.toThrow();

		expect(mod.getActiveKeychainStorage()).toBe(active);
		expect(active?.getItem('better-auth_cookie')).toBe('active');
		expect(secretSet).not.toHaveBeenCalled();
		expect(secretDelete).not.toHaveBeenCalled();
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

describe('completeConnection — the keychain handover', () => {
	// Re-authenticating the workspace this window is signed in to gives one
	// keychain entry two writers. The current one is stopped, and its started
	// writes finished, before the new session is written — so an older session
	// cannot land on top of the new one.
	it('stops the current writer of the same entry before writing the new session', async () => {
		loadWorkspaceStore.mockResolvedValue({
			workspaces: [workspaceConfig('ws-existing', 'https://acme.test')],
			activeWorkspaceId: 'ws-existing',
		});
		const mod = await freshModule();
		await mod.loadWorkspaces();
		const state = await beginConnect(mod);
		// The current client refreshed its (older) session; the debounce holds it.
		mod.getActiveKeychainStorage()?.setItem('better-auth_cookie', 'older');
		getSession.mockImplementation(async () => {
			return { data: { user: { id: 'user-1' } } };
		});

		await mod.completeConnection({ ott: 'tok', state });
		await new Promise((resolve) => setTimeout(resolve, 300));

		const writes = secretSet.mock.calls.filter(([key]) => key === 'owlat-ws:ws-existing');
		expect(writes).toHaveLength(1);
		expect(writes[0]?.[1]).not.toContain('older');
		expect(assign).toHaveBeenCalledWith('/dashboard');
	});

	// Connecting ANOTHER workspace leaves the current one's entry to it, but the
	// reload into the new workspace ends this page: a change the current
	// storage still holds is written first, to its own entry.
	it("writes the current workspace's pending change to its own entry before the reload", async () => {
		loadWorkspaceStore.mockResolvedValue({
			workspaces: [workspaceConfig('ws-other', 'https://other.test')],
			activeWorkspaceId: 'ws-other',
		});
		const mod = await freshModule();
		await mod.loadWorkspaces();
		const state = await beginConnect(mod);
		mod.getActiveKeychainStorage()?.setItem('better-auth_cookie', 'refreshed');
		assign.mockImplementation(() => {
			expect(secretSet).toHaveBeenCalledWith(
				'owlat-ws:ws-other',
				JSON.stringify({ 'better-auth_cookie': 'refreshed' })
			);
		});

		await mod.completeConnection({ ott: 'tok', state });

		const newEntry = secretSet.mock.calls.find(([key]) => key !== 'owlat-ws:ws-other');
		expect(newEntry?.[1]).not.toContain('refreshed');
		expect(assign).toHaveBeenCalledTimes(1);
	});

	// Saving the workspace list failed after the session was written: the list
	// goes back to what is on disk and the new entry is not left behind.
	it('restores the list and drops the new entry when the list cannot be saved', async () => {
		const mod = await freshModule();
		await mod.loadWorkspaces();
		const state = await beginConnect(mod);
		saveWorkspaceStore.mockRejectedValueOnce(new Error('disk full'));

		await expect(mod.completeConnection({ ott: 'tok', state })).rejects.toThrow('disk full');

		expect(mod.useDesktopWorkspaces().workspaces.value).toEqual([]);
		expect(mod.useDesktopWorkspaces().activeId.value).toBeNull();
		const written = secretSet.mock.calls[0]?.[0];
		expect(written).toMatch(/^owlat-ws:/);
		expect(secretDelete).toHaveBeenCalledWith(written);
		expect(assign).not.toHaveBeenCalled();
	});
});

describe('completeConnection — two deep links at once', () => {
	it('completes them one at a time', async () => {
		const mod = await freshModule();
		await mod.loadWorkspaces();
		const first = await beginConnect(mod);
		const second = await beginConnect(mod);
		let inFlight = 0;
		let overlapped = false;
		authFetch.mockImplementation(async () => {
			inFlight++;
			overlapped ||= inFlight > 1;
			await new Promise((resolve) => setTimeout(resolve, 5));
			inFlight--;
			return { data: { data: null, error: { status: 500 } }, error: { status: 500 } };
		});

		const results = await Promise.allSettled([
			mod.completeConnection({ ott: 'a', state: first }),
			mod.completeConnection({ ott: 'b', state: second }),
		]);

		expect(overlapped).toBe(false);
		expect(authFetch).toHaveBeenCalledTimes(2);
		expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
	});

	// A committed connection reloads into its workspace and retires every other
	// handshake; one queued behind it has nothing left to do and must not fail
	// onto the connect screen or run a second handshake.
	it('lets a completion queued behind a committed one end quietly', async () => {
		const mod = await freshModule();
		await mod.loadWorkspaces();
		const first = await beginConnect(mod);
		const second = await beginConnect(mod);

		await Promise.all([
			mod.completeConnection({ ott: 'a', state: first }),
			mod.completeConnection({ ott: 'b', state: second }),
		]);

		expect(authFetch).toHaveBeenCalledTimes(1);
		expect(assign).toHaveBeenCalledTimes(1);
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
