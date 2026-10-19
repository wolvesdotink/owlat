import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceConfig, WorkspaceStoreShape } from '~/lib/desktop/workspaceTypes';
import { workspaceTokenRef } from '~/lib/desktop/workspaceTypes';

/**
 * Removing a workspace is several steps (sign out, discard the session, wipe
 * the offline cache, delete the keychain entry, drop it from the list, persist)
 * and any of them can reject after the earlier ones landed. The preferences
 * dialog then offers Retry, which runs the whole removal again, so every step
 * has to be safe to repeat: a retry finishes the removal, never brings the
 * removed session back, and navigates exactly once.
 */

type Stage = 'discard' | 'wipe' | 'keychain' | 'persist';
let failOnce: Stage | null = null;
function maybeFail(stage: Stage): void {
	if (failOnce !== stage) return;
	failOnce = null;
	throw new Error(`${stage} failed`);
}

const saveWorkspaceStore = vi.fn<(store: WorkspaceStoreShape) => Promise<void>>(async () => {});
const loadWorkspaceStore = vi.fn<() => Promise<WorkspaceStoreShape>>();
vi.mock('@owlat/desktop/src/workspace', () => ({
	saveWorkspaceStore: (store: WorkspaceStoreShape) => saveWorkspaceStore(store),
	loadWorkspaceStore: () => loadWorkspaceStore(),
}));

const SESSION_BLOB = JSON.stringify({ 'better-auth.session_token': 'token-of-w1' });
const sessionWrite = vi.fn(
	async (_account: string, _value: string, _revision: number) => 'written'
);
const sessionReplace = vi.fn(async (_account: string, _value: string | null) => 2);
vi.mock('@owlat/desktop/src/keychain', () => ({
	secretGet: vi.fn(async () => null),
	sessionRead: vi.fn(async () => ({ value: SESSION_BLOB, revision: 1 })),
	sessionWrite: (account: string, value: string, revision: number) =>
		sessionWrite(account, value, revision),
	sessionReplace: (account: string, value: string | null) => sessionReplace(account, value),
	onSessionReplaced: vi.fn(async () => () => {}),
}));

// The two bridges the removal awaits, failing once on demand.
vi.mock('~/lib/desktop/workspaceState', async (importOriginal) => {
	const actual = await importOriginal<typeof import('~/lib/desktop/workspaceState')>();
	return {
		...actual,
		keychain: async () => {
			maybeFail('keychain');
			return actual.keychain();
		},
		persistStore: async () => {
			maybeFail('persist');
			return actual.persistStore();
		},
	};
});

vi.mock('~/lib/desktop/keychainStorage', async (importOriginal) => {
	const actual = await importOriginal<typeof import('~/lib/desktop/keychainStorage')>();
	return {
		...actual,
		getActiveKeychainStorage: () => {
			const storage = actual.getActiveKeychainStorage();
			if (!storage) return storage;
			return {
				...storage,
				discard: async () => {
					await storage.discard();
					maybeFail('discard');
				},
			};
		},
	};
});

vi.mock('~/lib/desktop/activeWorkspace', () => ({
	isDesktopRuntime: () => true,
	setActiveWorkspace: vi.fn(),
}));
vi.mock('~/lib/desktop/workspaceAccent', () => ({ applyWorkspaceAccent: vi.fn() }));
vi.mock('~/lib/desktop/desktopAuthClient', () => ({ createActiveDesktopAuthClient: vi.fn() }));

const signOut = vi.fn(async () => ({}));
vi.mock('~/lib/auth-client', () => ({ authClient: { signOut: () => signOut() } }));
vi.mock('~/composables/useDesktopAppSettings', () => ({
	pruneWorkspaceSettings: vi.fn(async () => {}),
}));
const wipeOfflineCache = vi.fn(async () => {
	maybeFail('wipe');
});
vi.mock('~/composables/postbox/usePostboxOfflineCache', () => ({
	wipePostboxOfflineReadCache: () => wipeOfflineCache(),
}));

function workspace(id: string): WorkspaceConfig {
	return {
		id,
		label: `Workspace ${id}`,
		siteUrl: `https://${id}.owlat.example`,
		convexUrl: `https://${id}.convex.cloud`,
		convexSiteUrl: `https://${id}.convex.site`,
		userId: `user-${id}`,
		tokenRef: workspaceTokenRef(id),
		addedAt: 1,
		lastActiveAt: 1,
		accentColor: '#7a8c5a',
	};
}

let assign: ReturnType<typeof vi.fn>;

/** A fresh module graph per test: the workspace list is module state. */
async function boot() {
	vi.resetModules();
	const mod = await import('../useDesktopWorkspaces');
	const keychainStorage = await import('~/lib/desktop/keychainStorage');
	await mod.loadWorkspaces();
	saveWorkspaceStore.mockClear();
	sessionWrite.mockClear();
	sessionReplace.mockClear();
	signOut.mockClear();
	wipeOfflineCache.mockClear();
	return { workspaces: mod.useDesktopWorkspaces(), keychainStorage };
}

beforeEach(() => {
	failOnce = null;
	assign = vi.fn();
	Object.defineProperty(window.location, 'assign', {
		value: assign,
		configurable: true,
		writable: true,
	});
	loadWorkspaceStore.mockResolvedValue({
		workspaces: [workspace('w1'), workspace('w2')],
		activeWorkspaceId: 'w1',
	});
});

function lastSavedStore(): WorkspaceStoreShape | undefined {
	return saveWorkspaceStore.mock.calls.at(-1)?.[0];
}

describe('removeWorkspace after a rejected step', () => {
	it.each<Stage>(['discard', 'wipe', 'keychain', 'persist'])(
		'a retry after the %s step rejected finishes the removal and navigates once',
		async (stage) => {
			const { workspaces, keychainStorage } = await boot();
			failOnce = stage;

			await expect(workspaces.removeWorkspace('w1')).rejects.toThrow(`${stage} failed`);
			expect(assign).not.toHaveBeenCalled();

			// Whatever still holds the old storage (the auth client) touching it
			// between the attempts cannot write the session back.
			keychainStorage
				.getActiveKeychainStorage()
				?.setItem('better-auth.session_token', 'token-of-w1');
			await keychainStorage.getActiveKeychainStorage()?.flush();

			await workspaces.removeWorkspace('w1');

			expect(assign).toHaveBeenCalledTimes(1);
			expect(assign).toHaveBeenCalledWith('/dashboard');
			expect(workspaces.workspaces.value.map((w) => w.id)).toEqual(['w2']);
			expect(workspaces.activeId.value).toBe('w2');
			expect(lastSavedStore()).toEqual({
				workspaces: [expect.objectContaining({ id: 'w2' })],
				activeWorkspaceId: 'w2',
			});
			expect(sessionReplace).toHaveBeenCalledWith(workspaceTokenRef('w1'), null);
			expect(sessionReplace.mock.calls.every(([, value]) => value === null)).toBe(true);
			expect(sessionWrite).not.toHaveBeenCalled();
		}
	);

	it('carries on when the sign-out itself rejects', async () => {
		const { workspaces } = await boot();
		signOut.mockRejectedValueOnce(new Error('offline'));

		await workspaces.removeWorkspace('w1');

		expect(assign).toHaveBeenCalledTimes(1);
		expect(workspaces.workspaces.value.map((w) => w.id)).toEqual(['w2']);
		expect(sessionReplace).toHaveBeenCalledWith(workspaceTokenRef('w1'), null);
	});

	it('does not pick a new active workspace twice when the retry follows a failed save', async () => {
		const { workspaces } = await boot();
		failOnce = 'persist';

		await expect(workspaces.removeWorkspace('w1')).rejects.toThrow('persist failed');
		// The list and the active id moved in memory before the save rejected.
		expect(workspaces.workspaces.value.map((w) => w.id)).toEqual(['w2']);
		expect(workspaces.activeId.value).toBe('w2');

		await workspaces.removeWorkspace('w1');

		// The retry sees w1 is no longer active: no second sign-out of the
		// workspace this window may now be bound to.
		expect(signOut).toHaveBeenCalledTimes(1);
		expect(workspaces.activeId.value).toBe('w2');
		expect(assign).toHaveBeenCalledTimes(1);
	});

	it('retries the removal of a workspace that is not the active one', async () => {
		const { workspaces } = await boot();
		failOnce = 'keychain';

		await expect(workspaces.removeWorkspace('w2')).rejects.toThrow('keychain failed');
		await workspaces.removeWorkspace('w2');

		expect(signOut).not.toHaveBeenCalled();
		expect(workspaces.workspaces.value.map((w) => w.id)).toEqual(['w1']);
		expect(workspaces.activeId.value).toBe('w1');
		expect(sessionReplace).toHaveBeenCalledWith(workspaceTokenRef('w2'), null);
		expect(assign).toHaveBeenCalledTimes(1);
		expect(assign).toHaveBeenCalledWith('/dashboard');
	});
});
