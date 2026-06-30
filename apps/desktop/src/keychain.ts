/**
 * Keychain bridge.
 *
 * Wraps the native `secret_*` Tauri commands (implemented in Rust over the
 * `keyring` crate → macOS Keychain / Windows Credential Manager / Linux Secret
 * Service). Used to store BetterAuth session blobs for each workspace.
 */
import { invoke } from '@tauri-apps/api/core';

export async function secretGet(account: string): Promise<string | null> {
	try {
		return await invoke<string | null>('secret_get', { account });
	} catch (e) {
		console.warn('[desktop] secret_get failed:', e);
		return null;
	}
}

export async function secretSet(account: string, value: string): Promise<void> {
	try {
		await invoke('secret_set', { account, value });
	} catch (e) {
		console.warn('[desktop] secret_set failed:', e);
	}
}

export async function secretDelete(account: string): Promise<void> {
	try {
		await invoke('secret_delete', { account });
	} catch (e) {
		console.warn('[desktop] secret_delete failed:', e);
	}
}
