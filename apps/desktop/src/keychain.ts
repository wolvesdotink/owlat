/**
 * Keychain bridge.
 *
 * Wraps the native `secret_*` / `session_secret_*` Tauri commands (implemented
 * in Rust over the `keyring` crate → macOS Keychain / Windows Credential
 * Manager / Linux Secret Service). Used to store BetterAuth session blobs for
 * each workspace.
 *
 * A session entry has one writer per open window, so it carries a revision
 * (see secrets.rs): a window writes back only the session it read, and a
 * sign-in or removal replaces it for every window at once.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** A session blob and the revision it was read at. */
export interface SessionEntry {
	value: string | null;
	revision: number;
}

/** What became of a window's write: `stale` means the session was replaced. */
export type SessionWriteOutcome = 'written' | 'stale' | 'failed';

/** A plain read, for callers that only look at a session (never write it). */
export async function secretGet(account: string): Promise<string | null> {
	try {
		return await invoke<string | null>('secret_get', { account });
	} catch (e) {
		console.warn('[desktop] secret_get failed:', e);
		return null;
	}
}

/** Read a session with its revision; null when the keychain cannot be read. */
export async function sessionRead(account: string): Promise<SessionEntry | null> {
	try {
		return await invoke<SessionEntry>('session_secret_read', { account });
	} catch (e) {
		console.warn('[desktop] session_secret_read failed:', e);
		return null;
	}
}

/** Write back a window's copy of a session, read at `revision`. */
export async function sessionWrite(
	account: string,
	value: string,
	revision: number
): Promise<SessionWriteOutcome> {
	try {
		const written = await invoke<boolean>('session_secret_write', { account, value, revision });
		return written ? 'written' : 'stale';
	} catch (e) {
		console.warn('[desktop] session_secret_write failed:', e);
		return 'failed';
	}
}

/**
 * Store a new session for a workspace, or remove it (`null`), for every
 * window. Resolves with the new revision; rejects when the keychain refused.
 */
export async function sessionReplace(account: string, value: string | null): Promise<number> {
	return invoke<number>('session_secret_replace', { account, value });
}

/** Called in every window after a session was replaced or removed. */
export async function onSessionReplaced(
	cb: (account: string, revision: number) => void
): Promise<UnlistenFn> {
	return listen<{ account: string; revision: number }>('session-secret-replaced', (e) =>
		cb(e.payload.account, e.payload.revision)
	);
}
