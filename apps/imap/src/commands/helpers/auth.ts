/**
 * Auth + selection predicates shared across IMAP command modules.
 *
 * Returns null on success, an error line on failure. Modules call:
 *
 *   const fail = requireAuth(state, tag);
 *   if (fail) { send(fail); return syncSession(state); }
 *
 * Today's connection class had `requireAuth(tag) → boolean` that also
 * had the side effect of writing to the socket; the deepening pulls
 * the I/O out so the predicate is pure.
 */

import type { AuthState, ConnectionState, SelectedState } from '../types.js';

/** Returns null when authenticated; otherwise a BAD line to emit. */
export function requireAuth(state: ConnectionState, tag: string): string | null {
	if (state.auth) return null;
	return `${tag} BAD Not authenticated`;
}

/** Returns null when a folder is SELECTed; otherwise a BAD line to emit. */
export function requireSelect(state: ConnectionState, tag: string): string | null {
	if (state.selected) return null;
	return `${tag} BAD No mailbox selected`;
}

/**
 * Returns null when the SELECTed folder is writable; otherwise a NO
 * line to emit. Call after `requireSelect` so the selection is known
 * to exist.
 */
export function requireWritableSelect(state: ConnectionState, tag: string): string | null {
	if (state.selected?.readOnly) {
		return `${tag} NO Mailbox is read-only`;
	}
	return null;
}

/**
 * Narrowing assertion — call after `requireAuth` returned null. Keeps
 * the call sites free of `state.auth!` non-null assertions while
 * preserving today's runtime invariant.
 */
export function assertAuth(state: ConnectionState): AuthState {
	if (!state.auth) {
		throw new Error('assertAuth called without auth');
	}
	return state.auth;
}

export function assertSelected(state: ConnectionState): SelectedState {
	if (!state.selected) {
		throw new Error('assertSelected called without selected');
	}
	return state.selected;
}
