import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorkspaceConfig, WorkspaceStoreShape } from '~/lib/desktop/workspaceTypes';

// The workspace switch deliberately KEEPS a full webview reload: the auth +
// Convex singletons are built once at module load from the active workspace, so
// switching cleanly re-seeds them only by reloading into the newly-persisted
// active workspace. This test pins that invariant — `switchTo` must persist the
// new active workspace id BEFORE navigating, and it must navigate — so the
// reload's re-seed/keychain handoff has the right target to seed from.

const saveWorkspaceStore = vi.fn<(store: WorkspaceStoreShape) => Promise<void>>();
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

const applyWorkspaceAccent = vi.fn();
vi.mock('~/lib/desktop/workspaceAccent', () => ({
	applyWorkspaceAccent: (...args: unknown[]) => applyWorkspaceAccent(...args),
}));

const writeSwitchFlag = vi.fn();
vi.mock('~/lib/desktop/workspaceSwitch', () => ({
	showSwitchSkeleton: vi.fn(() => ({})),
	hideSwitchSkeleton: vi.fn(),
	writeSwitchFlag: (...args: unknown[]) => writeSwitchFlag(...args),
	SWITCH_FLAG_TTL_MS: 1000,
}));

import { loadWorkspaces, useDesktopWorkspaces } from '../useDesktopWorkspaces';

function workspace(id: string, accentColor: WorkspaceConfig['accentColor']): WorkspaceConfig {
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
		accentColor,
	};
}

describe('useDesktopWorkspaces.switchTo — re-seed handoff into the reloaded document', () => {
	let assign: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		saveWorkspaceStore.mockClear();
		writeSwitchFlag.mockClear();
		applyWorkspaceAccent.mockClear();
		assign = vi.fn();
		// happy-dom's window.location.assign is a no-op; replace it so we can
		// observe the navigation that triggers the re-seed.
		Object.defineProperty(window.location, 'assign', {
			value: assign,
			configurable: true,
			writable: true,
		});
		loadWorkspaceStore.mockResolvedValue({
			workspaces: [workspace('w1', '#7a8c5a'), workspace('w2', '#c4785a')],
			activeWorkspaceId: 'w1',
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// One test only: the composable keeps module-level active-workspace state, so
	// a single load → switch flow avoids leaking a mutated active id across cases.
	it('persists the new active workspace and hands its accent to the reloaded document', async () => {
		await loadWorkspaces();
		// Ignore the load-time persist (accent backfill); assert on the switch.
		saveWorkspaceStore.mockClear();

		await useDesktopWorkspaces().switchTo('w2');

		// The persisted store — the sole input the reloaded document's singletons
		// re-seed from — must name the new active workspace, and it must be written
		// (the auth/keychain handoff) before the navigation that reloads into it.
		expect(saveWorkspaceStore).toHaveBeenCalledTimes(1);
		const persisted = saveWorkspaceStore.mock.calls[0]?.[0] as WorkspaceStoreShape;
		expect(persisted.activeWorkspaceId).toBe('w2');

		// The switch must actually navigate — the reload is what re-seeds the
		// singletons; without it the re-seed never happens.
		expect(assign).toHaveBeenCalledWith('/dashboard');

		// The destination accent is repainted and handed to the fresh document via
		// the switch flag so the reload replaces like-with-like (piece d4).
		expect(applyWorkspaceAccent).toHaveBeenCalled();
		expect(writeSwitchFlag).toHaveBeenCalledTimes(1);
		const flag = writeSwitchFlag.mock.calls[0]?.[1] as { accent: string; label: string };
		expect(flag.accent).toBe('#c4785a');
	});
});
