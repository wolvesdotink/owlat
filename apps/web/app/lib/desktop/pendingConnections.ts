/**
 * In-flight desktop sign-in handshakes, durable across an app restart.
 *
 * `addWorkspace()` mints a CSRF `state` nonce, remembers which instance it
 * belongs to, and opens the system browser. The browser hands the one-time
 * token back via `owlat://auth?ott=…&state=…`, and `completeConnection()` looks
 * the nonce up again to learn WHICH instance is being connected.
 *
 * That lookup used to read an in-memory Map, which made the cold-start path
 * impossible: if the app was not already running, macOS LAUNCHES it to deliver
 * the deep link, so the process handling `owlat://auth` is a brand-new one whose
 * Map is empty — every such handshake died as a bogus "state mismatch". Keeping
 * the records in `localStorage` (the webview's durable origin storage, which
 * survives the relaunch) makes the nonce resolvable in the fresh process.
 *
 * Only non-secret data lives here: a workspace id and the instance's public
 * /api/instance-info. The one-time token itself never touches this store — it
 * arrives on the deep link and is redeemed immediately.
 */
import type { InstanceInfo } from '~/lib/desktop/workspaceTypes';

/** localStorage key holding the `state` → handshake map. */
export const PENDING_CONNECTIONS_KEY = 'owlat:pending-connections';

/**
 * How long a handshake stays resolvable. The server's one-time token expires
 * after 3 minutes, so this is deliberately longer: a record that outlives its
 * token lets `completeConnection` fail with the REAL reason (the redeem was
 * rejected) instead of the misleading "state mismatch" a pruned record produces.
 */
export const PENDING_CONNECTION_TTL_MS = 10 * 60 * 1000;

/** One in-flight handshake: which workspace/instance a `state` nonce belongs to. */
export interface PendingConnection {
	/** Workspace id minted when the handshake began — reused on completion. */
	id: string;
	/** The instance being connected, as returned by /api/instance-info. */
	info: InstanceInfo;
	/** Epoch ms the handshake began (for the TTL prune). */
	at: number;
}

/** The slice of the Storage API this module needs (so tests can pass a fake). */
export type PendingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function isPending(value: unknown): value is PendingConnection {
	if (!value || typeof value !== 'object') return false;
	const entry = value as Partial<PendingConnection>;
	return (
		typeof entry.id === 'string' &&
		typeof entry.at === 'number' &&
		!!entry.info &&
		typeof entry.info === 'object' &&
		typeof entry.info.convexUrl === 'string' &&
		typeof entry.info.convexSiteUrl === 'string'
	);
}

/**
 * All non-expired handshakes. Corrupt or malformed storage reads as empty
 * rather than throwing — a lost nonce costs one retry, an exception at boot
 * would take down deep-link handling entirely.
 */
export function readPendingConnections(
	storage: PendingStorage,
	now: number
): Record<string, PendingConnection> {
	let raw: string | null = null;
	try {
		raw = storage.getItem(PENDING_CONNECTIONS_KEY);
	} catch {
		return {};
	}
	if (!raw) return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== 'object') return {};

	const fresh: Record<string, PendingConnection> = {};
	for (const [state, entry] of Object.entries(parsed as Record<string, unknown>)) {
		if (isPending(entry) && now - entry.at < PENDING_CONNECTION_TTL_MS) fresh[state] = entry;
	}
	return fresh;
}

/** Record a handshake, pruning any that have expired in the meantime. */
export function writePendingConnection(
	storage: PendingStorage,
	state: string,
	entry: PendingConnection
): void {
	const next = { ...readPendingConnections(storage, entry.at), [state]: entry };
	try {
		storage.setItem(PENDING_CONNECTIONS_KEY, JSON.stringify(next));
	} catch {
		// Storage unavailable/full — the handshake simply won't survive a restart.
	}
}

/**
 * Consume a handshake: returns it and removes it, so a replayed deep link (the
 * same `owlat://auth` URL delivered twice) cannot redeem a token twice.
 */
export function takePendingConnection(
	storage: PendingStorage,
	state: string,
	now: number
): PendingConnection | null {
	const all = readPendingConnections(storage, now);
	const entry = all[state];
	if (!entry) return null;
	delete all[state];
	try {
		storage.setItem(PENDING_CONNECTIONS_KEY, JSON.stringify(all));
	} catch {
		// Best-effort; the TTL prunes it eventually.
	}
	return entry;
}

/** Drop every pending handshake (a completed or abandoned connect flow). */
export function clearPendingConnections(storage: PendingStorage): void {
	try {
		storage.removeItem(PENDING_CONNECTIONS_KEY);
	} catch {
		// Best-effort.
	}
}
