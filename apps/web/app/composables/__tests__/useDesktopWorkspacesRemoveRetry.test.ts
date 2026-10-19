import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceConfig, WorkspaceStoreShape } from '~/lib/desktop/workspaceTypes';
import { workspaceTokenRef } from '~/lib/desktop/workspaceTypes';
import type * as KeychainStorageModule from '~/lib/desktop/keychainStorage';
import type * as WorkspaceStateModule from '~/lib/desktop/workspaceState';

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
// The keychain entries, so a reload reads back what the removal deleted.
const keychainEntries = new Map<string, { value: string | null; revision: number }>();
const sessionReplace = vi.fn(async (account: string, value: string | null) => {
	const revision = (keychainEntries.get(account)?.revision ?? 0) + 1;
	keychainEntries.set(account, { value, revision });
	return revision;
});
vi.mock('@owlat/desktop/src/keychain', () => ({
	secretGet: vi.fn(async () => null),
	sessionRead: vi.fn(async (account: string) => keychainEntries.get(account) ?? null),
	sessionWrite: (account: string, value: string, revision: number) =>
		sessionWrite(account, value, revision),
	sessionReplace: (account: string, value: string | null) => sessionReplace(account, value),
	onSessionReplaced: vi.fn(async () => () => {}),
}));

// The two bridges the removal awaits, failing once on demand.
vi.mock('~/lib/desktop/workspaceState', async (importOriginal) => {
	const actual = await importOriginal<typeof WorkspaceStateModule>();
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
	const actual = await importOriginal<typeof KeychainStorageModule>();
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
// A switch paints a skeleton and arms a stale-skeleton reload; neither is under
// test, and the fallback must not fire into a later test's reload spy.
vi.mock('~/lib/desktop/workspaceSwitch', () => ({
	showSwitchSkeleton: vi.fn(() => ({})),
	hideSwitchSkeleton: vi.fn(),
	writeSwitchFlag: vi.fn(),
	SWITCH_FLAG_TTL_MS: 1_000_000_000,
}));
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
let reload: ReturnType<typeof vi.fn>;

/**
 * A fresh module graph per test: the workspace list is module state. By default
 * the removals run on behalf of a mounted owner (as the preferences dialog
 * starts them), so a failure waits for the test to retry or give up.
 */
async function boot({ owned = true }: { owned?: boolean } = {}) {
	vi.resetModules();
	const mod = await import('../useDesktopWorkspaces');
	const keychainStorage = await import('~/lib/desktop/keychainStorage');
	await mod.loadWorkspaces();
	saveWorkspaceStore.mockClear();
	sessionWrite.mockClear();
	sessionReplace.mockClear();
	signOut.mockClear();
	wipeOfflineCache.mockClear();
	const api = mod.useDesktopWorkspaces();
	const owner = owned ? api.createRemovalOwner() : undefined;
	const workspaces = {
		...api,
		removeWorkspace: (id: string) => api.removeWorkspace(id, owner),
		// Cancel gives up on behalf of the owner that started the removal.
		abandonRemoval: () => api.abandonRemoval(owner),
	};
	return { api, workspaces, keychainStorage, owner };
}

beforeEach(() => {
	failOnce = null;
	assign = vi.fn();
	reload = vi.fn();
	Object.defineProperty(window.location, 'assign', {
		value: assign,
		configurable: true,
		writable: true,
	});
	Object.defineProperty(window.location, 'reload', {
		value: reload,
		configurable: true,
		writable: true,
	});
	keychainEntries.clear();
	keychainEntries.set(workspaceTokenRef('w1'), { value: SESSION_BLOB, revision: 1 });
	keychainEntries.set(workspaceTokenRef('w2'), { value: SESSION_BLOB, revision: 1 });
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

describe('abandoning a removal that rejected part-way', () => {
	it.each<Stage>(['discard', 'wipe', 'keychain', 'persist'])(
		'reloads after the %s step of removing the active workspace rejected',
		async (stage) => {
			const { workspaces } = await boot();
			failOnce = stage;
			await expect(workspaces.removeWorkspace('w1')).rejects.toThrow(`${stage} failed`);

			expect(workspaces.abandonRemoval()).not.toBeNull();

			expect(reload).toHaveBeenCalledTimes(1);
			expect(assign).not.toHaveBeenCalled();
			expect(sessionWrite).not.toHaveBeenCalled();
		}
	);

	it('comes back from a failed save in a state where the other workspace can be switched to', async () => {
		const first = await boot();
		failOnce = 'persist';
		await expect(first.workspaces.removeWorkspace('w1')).rejects.toThrow('persist failed');
		// Before settling: the list says w2 is active, the page is bound to w1, and
		// switching to w2 is a no-op because it already counts as active.
		expect(first.workspaces.activeId.value).toBe('w2');
		expect(first.keychainStorage.getActiveKeychainStorage()?.accountKey).toBe(
			workspaceTokenRef('w1')
		);
		await first.workspaces.switchTo('w2');
		expect(assign).not.toHaveBeenCalled();

		expect(first.workspaces.abandonRemoval()).not.toBeNull();
		expect(reload).toHaveBeenCalledTimes(1);

		// The reload boots from what was persisted: the save never landed, so the
		// store still lists w1 as active, but its keychain entry stays deleted.
		const second = await boot();
		expect(second.workspaces.workspaces.value.map((w) => w.id)).toEqual(['w1', 'w2']);
		expect(second.workspaces.activeId.value).toBe('w1');
		const bound = second.keychainStorage.getActiveKeychainStorage();
		expect(bound?.accountKey).toBe(workspaceTokenRef('w1'));
		expect(bound?.getItem('better-auth.session_token')).toBeNull();

		await second.workspaces.switchTo('w2');
		expect(assign).toHaveBeenCalledTimes(1);
		expect(assign).toHaveBeenCalledWith('/dashboard');
		expect(sessionWrite).not.toHaveBeenCalled();
	});

	it('reloads after a failed save while removing another workspace', async () => {
		const { workspaces } = await boot();
		failOnce = 'persist';
		await expect(workspaces.removeWorkspace('w2')).rejects.toThrow('persist failed');
		// The list in memory already lost w2; the store on disk did not.
		expect(workspaces.workspaces.value.map((w) => w.id)).toEqual(['w1']);

		expect(workspaces.abandonRemoval()).not.toBeNull();
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it.each<Stage>(['wipe', 'keychain'])(
		'leaves the page alone when removing another workspace rejected at the %s step',
		async (stage) => {
			const { workspaces } = await boot();
			failOnce = stage;
			await expect(workspaces.removeWorkspace('w2')).rejects.toThrow(`${stage} failed`);

			// Only device caches changed; the list, the active workspace and the
			// session this page is bound to are as they were.
			expect(workspaces.abandonRemoval()).toBeNull();
			expect(reload).not.toHaveBeenCalled();
			expect(workspaces.workspaces.value.map((w) => w.id)).toEqual(['w1', 'w2']);
			expect(workspaces.activeId.value).toBe('w1');
		}
	);

	it('does nothing when no removal ran', async () => {
		const { workspaces } = await boot();
		expect(workspaces.abandonRemoval()).toBeNull();
		expect(reload).not.toHaveBeenCalled();
	});
});

describe('who settles a failed removal', () => {
	it('settles it at once when the removal has no owner', async () => {
		const { workspaces } = await boot({ owned: false });
		failOnce = 'persist';

		await expect(workspaces.removeWorkspace('w1')).rejects.toThrow('persist failed');

		expect(reload).toHaveBeenCalledTimes(1);
		expect(assign).not.toHaveBeenCalled();
	});

	it('leaves a failure that changed nothing the page holds alone, with or without an owner', async () => {
		const { workspaces } = await boot({ owned: false });
		failOnce = 'keychain';

		await expect(workspaces.removeWorkspace('w2')).rejects.toThrow('keychain failed');

		expect(reload).not.toHaveBeenCalled();
	});

	it('waits for the owner while it is mounted', async () => {
		const { workspaces } = await boot();
		failOnce = 'persist';

		await expect(workspaces.removeWorkspace('w1')).rejects.toThrow('persist failed');

		expect(reload).not.toHaveBeenCalled();
	});

	it('settles a removal that rejects after its owner went away', async () => {
		const { workspaces, owner } = await boot();
		failOnce = 'persist';

		const removal = workspaces.removeWorkspace('w1');
		// The page unmounts while the removal is still on its first await.
		owner!.release();
		expect(reload).not.toHaveBeenCalled();
		await expect(removal).rejects.toThrow('persist failed');

		expect(reload).toHaveBeenCalledTimes(1);
		expect(assign).not.toHaveBeenCalled();
	});

	it('settles a removal that rejected before its owner went away', async () => {
		const { workspaces, owner } = await boot();
		failOnce = 'discard';
		await expect(workspaces.removeWorkspace('w1')).rejects.toThrow('discard failed');
		expect(reload).not.toHaveBeenCalled();

		owner!.release();

		expect(reload).toHaveBeenCalledTimes(1);
	});

	it('is not held back by a fresh page that mounted while the removal ran (leave, remount, reject)', async () => {
		const { api, workspaces, owner } = await boot();
		failOnce = 'persist';

		const removal = workspaces.removeWorkspace('w2');
		owner!.release();
		// The user comes back: a new instance of the page, with its own owner and
		// no dialog for the removal the old one started.
		const remounted = api.createRemovalOwner();
		await expect(removal).rejects.toThrow('persist failed');

		expect(reload).toHaveBeenCalledTimes(1);
		remounted.release();
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it('settles on the owner leaving even when a fresh page mounts after (reject, leave, remount)', async () => {
		const { api, workspaces, owner } = await boot();
		failOnce = 'persist';
		await expect(workspaces.removeWorkspace('w2')).rejects.toThrow('persist failed');
		// The list in memory lost w2; the store on disk did not.
		expect(workspaces.workspaces.value.map((w) => w.id)).toEqual(['w1']);

		owner!.release();
		expect(reload).toHaveBeenCalledTimes(1);

		const remounted = api.createRemovalOwner();
		remounted.release();
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it('lets only the view that started the removal keep it waiting', async () => {
		const { api, workspaces, owner } = await boot();
		// A second view is mounted at the same time but started nothing.
		const bystander = api.createRemovalOwner();
		failOnce = 'persist';
		await expect(workspaces.removeWorkspace('w1')).rejects.toThrow('persist failed');

		// The bystander leaving changes nothing: the failure is not its to settle.
		bystander.release();
		expect(reload).not.toHaveBeenCalled();
		// The starter leaving settles it.
		owner!.release();
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it('settles at once a removal started by a view with no retry while another view is mounted', async () => {
		const { api } = await boot({ owned: false });
		const bystander = api.createRemovalOwner();
		failOnce = 'persist';

		await expect(api.removeWorkspace('w1')).rejects.toThrow('persist failed');

		expect(reload).toHaveBeenCalledTimes(1);
		bystander.release();
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it('does not settle twice when the user gave up before the owner went away', async () => {
		const { workspaces, owner } = await boot();
		failOnce = 'persist';
		await expect(workspaces.removeWorkspace('w1')).rejects.toThrow('persist failed');

		expect(workspaces.abandonRemoval()).not.toBeNull();
		owner!.release();
		owner!.release();

		expect(reload).toHaveBeenCalledTimes(1);
	});

	it('has nothing to settle once a retry succeeded', async () => {
		const { workspaces, owner } = await boot();
		failOnce = 'wipe';
		await expect(workspaces.removeWorkspace('w1')).rejects.toThrow('wipe failed');

		await workspaces.removeWorkspace('w1');
		owner!.release();

		expect(assign).toHaveBeenCalledTimes(1);
		expect(reload).not.toHaveBeenCalled();
	});
});

describe('a reload that does not happen', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	/** Whether the promise from `abandonRemoval` resolved, i.e. the document
	 * outlived the reload it asked for. */
	function watch(reloadRequest: Promise<void> | null) {
		const state = { survived: false };
		void reloadRequest?.then(() => {
			state.survived = true;
		});
		return state;
	}

	/** Let the window in which the reload should have unloaded the page pass
	 * (its length is the mocked switch TTL). */
	async function outlastTheReload() {
		await vi.runOnlyPendingTimersAsync();
	}

	it('hands the failure back to its owner when the user stays on the page', async () => {
		const { workspaces, owner } = await boot();
		failOnce = 'persist';
		await expect(workspaces.removeWorkspace('w1')).rejects.toThrow('persist failed');
		vi.useFakeTimers();

		// Cancel asks for the reload; an unsaved-changes prompt keeps the page.
		const first = watch(workspaces.abandonRemoval());
		expect(reload).toHaveBeenCalledTimes(1);
		await outlastTheReload();
		expect(first.survived).toBe(true);

		// Giving up again asks again: nothing remembers the refused one.
		const second = watch(workspaces.abandonRemoval());
		expect(reload).toHaveBeenCalledTimes(2);
		await outlastTheReload();
		expect(second.survived).toBe(true);

		// And the owner leaving still settles it, since it is pending again.
		owner!.release();
		expect(reload).toHaveBeenCalledTimes(3);
	});

	it('asks for a reload again when a later attempt fails after a refused one', async () => {
		const { workspaces } = await boot();
		failOnce = 'persist';
		await expect(workspaces.removeWorkspace('w1')).rejects.toThrow('persist failed');
		vi.useFakeTimers();
		watch(workspaces.abandonRemoval());
		await outlastTheReload();

		failOnce = 'persist';
		await expect(workspaces.removeWorkspace('w1')).rejects.toThrow('persist failed');
		expect(workspaces.abandonRemoval()).not.toBeNull();

		expect(reload).toHaveBeenCalledTimes(2);
		expect(assign).not.toHaveBeenCalled();
	});

	it('reloads for a fresh page after a refused reload for an abandoned removal', async () => {
		// Leave during the removal of another workspace; the reload asked for
		// when it rejects is refused (a form with unsaved changes elsewhere).
		const { api, workspaces, owner } = await boot();
		failOnce = 'persist';
		const removal = workspaces.removeWorkspace('w2');
		owner!.release();
		vi.useFakeTimers();
		await expect(removal).rejects.toThrow('persist failed');
		expect(reload).toHaveBeenCalledTimes(1);
		await outlastTheReload();

		// Back on the preferences page: a new owner, another failing removal,
		// then Cancel. It reloads again rather than waiting on the refused one.
		const remounted = api.createRemovalOwner();
		failOnce = 'persist';
		await expect(api.removeWorkspace('w1', remounted)).rejects.toThrow('persist failed');
		const request = watch(api.abandonRemoval(remounted));

		expect(reload).toHaveBeenCalledTimes(2);
		await outlastTheReload();
		expect(request.survived).toBe(true);
	});

	it('does not hand anything back when the document did unload', async () => {
		const { workspaces, owner } = await boot();
		failOnce = 'persist';
		await expect(workspaces.removeWorkspace('w1')).rejects.toThrow('persist failed');
		vi.useFakeTimers();

		const request = watch(workspaces.abandonRemoval());
		window.dispatchEvent(new Event('pagehide'));
		await outlastTheReload();

		expect(request.survived).toBe(false);
		owner!.release();
		expect(reload).toHaveBeenCalledTimes(1);
	});
});
