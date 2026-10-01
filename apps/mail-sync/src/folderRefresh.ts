/**
 * Reading the provider's side for remoteState.ts: refreshing one tracked
 * folder's view, CHANGEDSINCE flag reads of an untracked folder (All Mail),
 * and the All Mail look-up for mail that seems to have vanished.
 */

import type { FlagState, FolderView } from './folderView.js';

/** `exists` is kept current by the client between SELECTs (EXISTS / EXPUNGE responses). */
type Mailbox =
	| false
	| {
			uidValidity: bigint | number;
			uidNext?: number;
			highestModseq?: bigint | number;
			exists?: number;
	  };

interface FetchedMessage {
	uid: number;
	flags?: Set<string>;
	headers?: Buffer;
	modseq?: bigint;
}

/** The slice of ImapFlow the views use, narrowed so tests can fake it. */
export interface RemoteStateClient {
	readonly mailbox: Mailbox;
	getMailboxLock(path: string): Promise<{ release(): void }>;
	search(query: object, options: { uid: true }): Promise<number[] | false | undefined>;
	fetch(
		range: string,
		query: { uid: true; flags: true; headers?: string[] },
		options: { uid: true; changedSince?: bigint }
	): AsyncIterable<FetchedMessage>;
}

/** UIDs per header / flag fetch. */
const FETCH_CHUNK = 200;
/** Without CONDSTORE, flags are re-read for this many of the newest messages. */
const FLAG_WINDOW = 500;
/** Message-IDs per OR-search when looking for vanished mail in All Mail. */
const CONFIRM_CHUNK = 20;
/**
 * Each folder's UID list is compared in full at least this often, whatever the
 * cheaper checks say — the fallback for a provider whose counts or events
 * cannot be trusted. With the five-minute periodic cycle that is a census about
 * every sixth cycle per folder.
 */
export const CENSUS_INTERVAL_MS = 30 * 60 * 1000;

const UID = { uid: true } as const;

/** All Mail's flag cursor: only CHANGEDSINCE is read there. */
export interface ModseqCursor {
	uidValidity: bigint | null;
	highestModseq: bigint | null;
}

export function canonicalMessageId(raw: string): string {
	return raw.replace(/[<>]/g, '').trim();
}

/** The Message-ID out of a `BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)]` answer. */
export function parseMessageIdHeader(headers: Buffer | undefined): string | null {
	if (!headers) return null;
	const unfolded = headers.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
	const match = /^message-id:\s*(.+)$/im.exec(unfolded);
	const id = match?.[1] ? canonicalMessageId(match[1]) : '';
	return id || null;
}

function toFlagState(flags: Set<string> | undefined): FlagState {
	return {
		seen: flags?.has('\\Seen') ?? false,
		flagged: flags?.has('\\Flagged') ?? false,
		answered: flags?.has('\\Answered') ?? false,
	};
}

export function sameFlags(a: FlagState, b: FlagState): boolean {
	return a.seen === b.seen && a.flagged === b.flagged && a.answered === b.answered;
}

export function chunks<T>(items: ReadonlyArray<T>, size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

function asBigInt(value: bigint | number | undefined): bigint | null {
	return value === undefined ? null : BigInt(value);
}

export interface RefreshResult {
	/** Message-IDs that arrived, left or changed flags since the last refresh. */
	changed: Set<string>;
	/** Message-IDs that left this folder. */
	vanished: Set<string>;
	/** The view was (re)built from scratch, so nothing is known to have changed. */
	rebuilt: boolean;
	/** The whole UID list was compared (`UID SEARCH ALL`). */
	census: boolean;
}

export interface RefreshOptions {
	/** Compare the whole UID list even if nothing suggests a message left. */
	census?: boolean;
	/** The reconcile's clock, recorded as the view's last census time. */
	now?: number;
	/**
	 * Where to record what was noticed, as the view changes. A refresh that
	 * throws part-way (a lost connection) has already moved the view on, so
	 * what it saw up to then must already be in the caller's carried sets.
	 */
	into?: RefreshSink;
}

/** The carried sets a refresh records into (the reconcile's pending changes). */
export interface RefreshSink {
	changed: Set<string>;
	vanished: Set<string>;
	rebuilt: boolean;
}

/**
 * Bring one folder's view up to date. Without `census` it looks only above the
 * highest known UID, and takes the census anyway when the message count shows
 * that something left. With `into`, the returned `changed`/`vanished` are the
 * sink's own sets.
 */
export async function refreshFolder(
	client: RemoteStateClient,
	path: string,
	view: FolderView,
	options: RefreshOptions = { census: true }
): Promise<RefreshResult> {
	const result: RefreshResult = {
		changed: options.into?.changed ?? new Set(),
		vanished: options.into?.vanished ?? new Set(),
		rebuilt: false,
		census: false,
	};
	const lock = await client.getMailboxLock(path);
	try {
		const mailbox = client.mailbox;
		if (!mailbox) return result;
		const uidValidity = BigInt(mailbox.uidValidity);
		if (view.uidValidity !== uidValidity) {
			view.clear();
			view.uidValidity = uidValidity;
			result.rebuilt = true;
			if (options.into) options.into.rebuilt = true;
		}

		let census = options.census === true || result.rebuilt || view.censusDue;
		if (!census) {
			const floor = view.maxUid;
			const hits = (await client.search({ uid: `${floor + 1}:*` }, UID)) || [];
			// `n:*` names the highest UID even when it is below n.
			await addArrivals(
				client,
				view,
				result,
				hits.filter((uid) => uid > floor)
			);
			// Read after the search, so it counts at least what the search saw.
			const now = client.mailbox;
			census = !now || typeof now.exists !== 'number' || now.exists !== view.size;
		}
		if (census) {
			const present = new Set((await client.search({ all: true }, UID)) || []);
			for (const [uid, cached] of view.entries()) {
				if (present.has(uid)) continue;
				view.delete(uid);
				if (cached.messageId) {
					result.vanished.add(cached.messageId);
					result.changed.add(cached.messageId);
				}
			}
			view.compact();
			const arrived = [...present].filter((uid) => !view.has(uid));
			await addArrivals(client, view, result, arrived);
			view.lastCensusAt = options.now ?? Date.now();
			view.censusDue = false;
			// UIDNEXT as of the SELECT: every UID below it was handed out before the
			// search ran, so one the search did not list had left by then.
			view.censusUidNext = mailbox.uidNext ?? 0;
			result.census = true;
		}

		// Asked even when the mailbox's HIGHESTMODSEQ looks unchanged: for the
		// folder kept selected for IDLE (INBOX) that value is only as fresh as the
		// last SELECT, and an empty CHANGEDSINCE answer costs one round trip.
		let modseq = asBigInt(mailbox.highestModseq);
		if (!result.rebuilt) {
			if (modseq !== null && view.highestModseq !== null) {
				const seen = await readFlags(client, '1:*', view, result, view.highestModseq);
				if (seen > modseq) modseq = seen;
			} else if (modseq === null) {
				const newest = view.newest(FLAG_WINDOW);
				for (const chunk of chunks(newest, FETCH_CHUNK)) {
					await readFlags(client, chunk.join(','), view, result);
				}
			}
		}
		view.highestModseq = modseq;
		return result;
	} finally {
		lock.release();
	}
}

async function addArrivals(
	client: RemoteStateClient,
	view: FolderView,
	result: RefreshResult,
	uids: ReadonlyArray<number>
): Promise<void> {
	for (const chunk of chunks(uids, FETCH_CHUNK)) {
		for await (const msg of client.fetch(
			chunk.join(','),
			{ uid: true, flags: true, headers: ['message-id'] },
			UID
		)) {
			const messageId = parseMessageIdHeader(msg.headers);
			view.set(Number(msg.uid), { messageId, flags: toFlagState(msg.flags) });
			if (messageId && !result.rebuilt) result.changed.add(messageId);
		}
	}
}

async function readFlags(
	client: RemoteStateClient,
	range: string,
	view: FolderView,
	result: RefreshResult,
	changedSince?: bigint
): Promise<bigint> {
	const options = changedSince === undefined ? UID : { uid: true as const, changedSince };
	let highest = changedSince ?? 0n;
	for await (const msg of client.fetch(range, { uid: true, flags: true }, options)) {
		if (msg.modseq !== undefined && msg.modseq > highest) highest = msg.modseq;
		const cached = view.get(Number(msg.uid));
		if (!cached) continue;
		const flags = toFlagState(msg.flags);
		if (sameFlags(flags, cached.flags)) continue;
		cached.flags = flags;
		if (cached.messageId) result.changed.add(cached.messageId);
	}
	return highest;
}

/**
 * Flag changes in an untracked folder (All Mail) since the last call, by
 * CHANGEDSINCE. Empty on the first call, which only records the cursor, and on
 * a server without CONDSTORE.
 */
export async function readChangedFlags(
	client: RemoteStateClient,
	path: string,
	cursor: ModseqCursor
): Promise<Map<string, FlagState>> {
	const changed = new Map<string, FlagState>();
	const lock = await client.getMailboxLock(path);
	try {
		const mailbox = client.mailbox;
		if (!mailbox) return changed;
		const uidValidity = BigInt(mailbox.uidValidity);
		const modseq = asBigInt(mailbox.highestModseq);
		const since = cursor.uidValidity === uidValidity ? cursor.highestModseq : null;
		if (since !== null && modseq !== null && modseq !== since) {
			for await (const msg of client.fetch(
				'1:*',
				{ uid: true, flags: true, headers: ['message-id'] },
				{ uid: true, changedSince: since }
			)) {
				const id = parseMessageIdHeader(msg.headers);
				if (id) changed.set(id, toFlagState(msg.flags));
			}
		}
		cursor.uidValidity = uidValidity;
		cursor.highestModseq = modseq;
		return changed;
	} finally {
		lock.release();
	}
}

/** Which of `ids` All Mail holds — the check before calling a message moved or deleted. */
export async function findInFolder(
	client: RemoteStateClient,
	path: string,
	ids: ReadonlyArray<string>
): Promise<Set<string>> {
	const found = new Set<string>();
	if (ids.length === 0) return found;
	const lock = await client.getMailboxLock(path);
	try {
		for (const chunk of chunks(ids, CONFIRM_CHUNK)) {
			const terms = chunk.map((id) => ({ header: { 'message-id': id } }));
			const hits = await client.search(terms.length === 1 ? terms[0]! : { or: terms }, UID);
			if (!hits || hits.length === 0) continue;
			const wanted = new Set(chunk);
			for (const part of chunks(hits, FETCH_CHUNK)) {
				for await (const msg of client.fetch(
					part.join(','),
					{ uid: true, flags: true, headers: ['message-id'] },
					UID
				)) {
					const id = parseMessageIdHeader(msg.headers);
					if (id && wanted.has(id)) found.add(id);
				}
			}
		}
		return found;
	} finally {
		lock.release();
	}
}
