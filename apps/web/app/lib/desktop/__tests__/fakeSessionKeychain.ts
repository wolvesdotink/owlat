import { vi } from 'vitest';

/**
 * A stand-in for `@owlat/desktop/src/keychain` that keeps the native session
 * ledger's rules (secrets.rs): a write lands only at the entry's current
 * revision, and a replace moves the revision on and tells every listener. One
 * instance plays the native process every window shares, so tests can boot
 * several windows (module graphs) against it.
 */
export function createFakeSessionKeychain() {
	const entries = new Map<string, string>();
	const revisions = new Map<string, number>();
	const listeners = new Set<(account: string, revision: number) => void>();
	/** When false, replace events are not delivered (a window that missed one). */
	let deliverEvents = true;
	const revisionOf = (account: string) => revisions.get(account) ?? 0;

	const sessionWrite = vi.fn(async (account: string, value: string, revision: number) => {
		if (revision !== revisionOf(account)) return 'stale' as const;
		entries.set(account, value);
		return 'written' as const;
	});
	const sessionReplace = vi.fn(async (account: string, value: string | null) => {
		if (value === null) entries.delete(account);
		else entries.set(account, value);
		const revision = revisionOf(account) + 1;
		revisions.set(account, revision);
		if (deliverEvents) for (const listener of listeners) listener(account, revision);
		return revision;
	});

	const bridge = {
		secretGet: async (account: string) => entries.get(account) ?? null,
		sessionRead: async (account: string) => ({
			value: entries.get(account) ?? null,
			revision: revisionOf(account),
		}),
		sessionWrite,
		sessionReplace,
		onSessionReplaced: async (cb: (account: string, revision: number) => void) => {
			listeners.add(cb);
			return () => void listeners.delete(cb);
		},
	};

	return {
		entries,
		bridge,
		sessionWrite,
		sessionReplace,
		setDeliverEvents(value: boolean) {
			deliverEvents = value;
		},
		reset() {
			entries.clear();
			revisions.clear();
			listeners.clear();
			deliverEvents = true;
			sessionWrite.mockClear();
			sessionReplace.mockClear();
		},
	};
}
