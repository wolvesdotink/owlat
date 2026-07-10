/**
 * Workspace metadata persistence bridge.
 *
 * Stores the non-secret workspace list + active id in `workspaces.json` via
 * tauri-plugin-store. Secrets (session tokens) live in the keychain (see
 * keychain.ts), referenced only by `tokenRef`.
 *
 * Deals in plain JSON so this module stays decoupled from the web app's types
 * (the web side casts to WorkspaceStoreShape). Each persisted workspace record
 * carries an `accentColor` (hex) identity accent alongside its metadata; it
 * flows through this pass-through store untouched.
 */
import { load } from '@tauri-apps/plugin-store';

const FILE = 'workspaces.json';
const KEY = 'state';

type StoreShape = { workspaces: unknown[]; activeWorkspaceId: string | null };

export async function loadWorkspaceStore(): Promise<StoreShape> {
	try {
		const store = await load(FILE);
		const state = (await store.get<StoreShape>(KEY)) ?? null;
		if (state && Array.isArray(state.workspaces)) return state;
	} catch (e) {
		console.warn('[desktop] loadWorkspaceStore failed:', e);
	}
	return { workspaces: [], activeWorkspaceId: null };
}

export async function saveWorkspaceStore(state: StoreShape): Promise<void> {
	try {
		const store = await load(FILE);
		await store.set(KEY, state);
		await store.save();
	} catch (e) {
		console.warn('[desktop] saveWorkspaceStore failed:', e);
	}
}
