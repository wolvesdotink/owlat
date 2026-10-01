import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkspaceConfig, WorkspaceStoreShape } from '~/lib/desktop/workspaceTypes';

// Boot of the desktop workspace list: the "Open at startup" pin comes from the
// device settings, the list from the workspace store. Both are IPC reads, and
// the boot plugin hands the pin over as a promise so the two run side by side
// instead of one after the other.

const saveWorkspaceStore = vi.fn<(store: WorkspaceStoreShape) => Promise<void>>(async () => {});
const loadWorkspaceStore = vi.fn<() => Promise<WorkspaceStoreShape>>();
vi.mock('@owlat/desktop/src/workspace', () => ({
	saveWorkspaceStore: (store: WorkspaceStoreShape) => saveWorkspaceStore(store),
	loadWorkspaceStore: () => loadWorkspaceStore(),
}));

vi.mock('@owlat/desktop/src/keychain', () => ({
	secretGet: vi.fn(async () => 'session-blob'),
	sessionRead: vi.fn(async () => ({ value: 'session-blob', revision: 0 })),
	sessionWrite: vi.fn(async () => 'written'),
	sessionReplace: vi.fn(async () => 1),
	onSessionReplaced: vi.fn(async () => () => {}),
}));

const setActiveWorkspace = vi.fn();
vi.mock('~/lib/desktop/activeWorkspace', () => ({
	isDesktopRuntime: () => true,
	setActiveWorkspace: (...args: unknown[]) => setActiveWorkspace(...args),
}));

function workspace(id: string): WorkspaceConfig {
	return {
		id,
		label: `Workspace ${id}`,
		siteUrl: `https://${id}.owlat.app`,
		convexUrl: `https://${id}.convex.cloud`,
		convexSiteUrl: `https://${id}.convex.site`,
		userId: `user-${id}`,
		tokenRef: `token-${id}`,
		addedAt: 1,
		lastActiveAt: 1,
		accentColor: '#7a8c5a',
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** The workspace list is module state; every case gets its own copy. */
async function freshModule() {
	vi.resetModules();
	return import('../useDesktopWorkspaces');
}

beforeEach(() => {
	vi.clearAllMocks();
	loadWorkspaceStore.mockResolvedValue({
		workspaces: [workspace('w1'), workspace('w2')],
		activeWorkspaceId: 'w1',
	});
});

describe('loadWorkspaces — the startup pin', () => {
	it('reads the workspace store while the pin is still loading', async () => {
		const pin = deferred<string | null>();
		const { loadWorkspaces } = await freshModule();

		const done = loadWorkspaces({ preferredActiveId: pin.promise });
		// The store read starts without waiting for the settings.
		await vi.waitFor(() => expect(loadWorkspaceStore).toHaveBeenCalledTimes(1));
		expect(setActiveWorkspace).not.toHaveBeenCalled();

		pin.resolve('w2');
		await done;

		expect(setActiveWorkspace).toHaveBeenCalledWith(expect.objectContaining({ id: 'w2' }));
		expect(saveWorkspaceStore.mock.calls.at(-1)?.[0].activeWorkspaceId).toBe('w2');
	});

	it('still takes a plain pin value', async () => {
		const { loadWorkspaces } = await freshModule();
		await loadWorkspaces({ preferredActiveId: 'w2' });
		expect(setActiveWorkspace).toHaveBeenCalledWith(expect.objectContaining({ id: 'w2' }));
	});

	it('keeps the last-active workspace when the pin names one that is gone', async () => {
		const { loadWorkspaces } = await freshModule();
		await loadWorkspaces({ preferredActiveId: Promise.resolve('removed') });
		expect(setActiveWorkspace).toHaveBeenCalledWith(expect.objectContaining({ id: 'w1' }));
		expect(saveWorkspaceStore).not.toHaveBeenCalled();
	});
});
