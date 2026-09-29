import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceConfig, WorkspaceStoreShape } from '~/lib/desktop/workspaceTypes';
import { FEATURE_FLAG_CACHE_KEY, writeCachedFeatureFlags } from '~/lib/featureFlagCache';

/**
 * Removing a desktop workspace signs out of it through `authClient.signOut()`
 * directly, not through `useAuth().signOut`, so it has to forget the
 * last-known feature flags itself. Otherwise the next session in this app
 * would boot with the removed workspace's nav.
 */

const saveWorkspaceStore = vi.fn<(store: WorkspaceStoreShape) => Promise<void>>(async () => {});
const loadWorkspaceStore = vi.fn<() => Promise<WorkspaceStoreShape>>();
vi.mock('@owlat/desktop/src/workspace', () => ({
	saveWorkspaceStore: (store: WorkspaceStoreShape) => saveWorkspaceStore(store),
	loadWorkspaceStore: () => loadWorkspaceStore(),
}));

vi.mock('@owlat/desktop/src/keychain', () => ({
	secretGet: vi.fn(async () => 'session-blob'),
	secretSet: vi.fn(async () => {}),
	secretDelete: vi.fn(async () => {}),
}));

vi.mock('~/lib/desktop/activeWorkspace', () => ({
	isDesktopRuntime: () => true,
	setActiveWorkspace: vi.fn(),
}));

vi.mock('~/lib/desktop/keychainStorage', () => ({
	keychainStorage: {},
	configureKeychainStorage: vi.fn(),
	clearKeychainStorage: vi.fn(),
	snapshotKeychain: vi.fn(() => ''),
}));

vi.mock('~/lib/desktop/workspaceAccent', () => ({ applyWorkspaceAccent: vi.fn() }));

vi.mock('~/lib/auth-client', () => ({ authClient: { signOut: vi.fn(async () => ({})) } }));
vi.mock('~/composables/useDesktopAppSettings', () => ({
	pruneWorkspaceSettings: vi.fn(async () => {}),
}));

import { loadWorkspaces, useDesktopWorkspaces } from '../useDesktopWorkspaces';

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

beforeEach(() => {
	localStorage.clear();
	Object.defineProperty(window.location, 'assign', {
		value: vi.fn(),
		configurable: true,
		writable: true,
	});
	loadWorkspaceStore.mockResolvedValue({
		workspaces: [workspace('w1'), workspace('w2')],
		activeWorkspaceId: 'w1',
	});
});

afterEach(() => {
	localStorage.clear();
});

describe('useDesktopWorkspaces.removeWorkspace', () => {
	it('forgets the cached feature flags', async () => {
		await loadWorkspaces();
		writeCachedFeatureFlags('https://w1.convex.cloud', { postbox: true });

		await useDesktopWorkspaces().removeWorkspace('w1');

		expect(localStorage.getItem(FEATURE_FLAG_CACHE_KEY)).toBeNull();
	});
});
