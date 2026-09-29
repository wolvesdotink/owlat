/**
 * Remote → local change sync: noticing what happened on the provider to mail
 * Owlat already has, and reporting it (`apps/api/convex/mail/external/remoteState.ts`
 * applies it).
 *
 * Every synced folder keeps a view in memory — UID → Message-ID + flags. Each
 * cycle refreshes it cheaply: `UID SEARCH ALL` shows which UIDs left and which
 * arrived (only the arrivals' Message-ID headers are fetched), and flags come
 * from `CHANGEDSINCE` where the server has CONDSTORE, else from the newest
 * messages. Joining the views gives, per Message-ID, the folders holding it
 * now; a local message whose folder is not among them has moved, and one that
 * left its folder and is nowhere was deleted.
 *
 * Normally only the Message-IDs that changed are looked up in Owlat. A FULL
 * reconcile compares every local message instead: after a restart (the views
 * are empty, so nothing is known to have changed), after a UIDVALIDITY reset,
 * while the account is not yet aligned, and every few hours as a safety net.
 *
 * Gmail's All Mail holds every message and is not kept as a view: it is too
 * large, and a message in it alone is simply archived. Where a local message
 * seems to have vanished, All Mail is searched for it before anything is
 * reported, and its flag changes are read with CHANGEDSINCE.
 */

import type { FolderRole } from './folders.js';

export interface FlagState {
	seen: boolean;
	flagged: boolean;
	answered: boolean;
}

/** One local message as `listLocalMessages` / `lookupLocalMessages` return it. */
export interface LocalMessageRow {
	messageId: string;
	/** Remote folder the local folder syncs with; null for a local-only folder. */
	remoteName: string | null;
	role: FolderRole | null;
	flags: FlagState;
}

/** What `applyRemoteObservations` takes. */
export interface RemoteObservation {
	messageId: string;
	remoteFolders?: string[];
	isGone?: boolean;
	flags?: FlagState;
}

interface CachedMessage {
	messageId: string | null;
	flags: FlagState;
}

type Mailbox = false | { uidValidity: bigint | number; highestModseq?: bigint | number };

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
/** All Mail look-ups per cycle; the rest wait for the next one. */
const MAX_CONFIRMS_PER_CYCLE = 500;
/** Local messages per page of a full reconcile. */
export const LOCAL_PAGE = 500;
const LOOKUP_CHUNK = 200;
const APPLY_CHUNK = 100;

const UID = { uid: true } as const;

/** A synced folder's last known contents. */
export class FolderView {
	uidValidity: bigint | null = null;
	highestModseq: bigint | null = null;
	readonly messages = new Map<number, CachedMessage>();
}

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

function sameFlags(a: FlagState, b: FlagState): boolean {
	return a.seen === b.seen && a.flagged === b.flagged && a.answered === b.answered;
}

function chunks<T>(items: ReadonlyArray<T>, size: number): T[][] {
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
}

/** Bring one folder's view up to date. */
export async function refreshFolder(
	client: RemoteStateClient,
	path: string,
	view: FolderView
): Promise<RefreshResult> {
	const result: RefreshResult = { changed: new Set(), vanished: new Set(), rebuilt: false };
	const lock = await client.getMailboxLock(path);
	try {
		const mailbox = client.mailbox;
		if (!mailbox) return result;
		const uidValidity = BigInt(mailbox.uidValidity);
		if (view.uidValidity !== uidValidity) {
			view.messages.clear();
			view.highestModseq = null;
			view.uidValidity = uidValidity;
			result.rebuilt = true;
		}

		const present = new Set((await client.search({ all: true }, UID)) || []);
		for (const [uid, cached] of view.messages) {
			if (present.has(uid)) continue;
			view.messages.delete(uid);
			if (cached.messageId) {
				result.vanished.add(cached.messageId);
				result.changed.add(cached.messageId);
			}
		}

		const arrived = [...present].filter((uid) => !view.messages.has(uid));
		for (const chunk of chunks(arrived, FETCH_CHUNK)) {
			for await (const msg of client.fetch(
				chunk.join(','),
				{ uid: true, flags: true, headers: ['message-id'] },
				UID
			)) {
				const messageId = parseMessageIdHeader(msg.headers);
				view.messages.set(Number(msg.uid), { messageId, flags: toFlagState(msg.flags) });
				if (messageId && !result.rebuilt) result.changed.add(messageId);
			}
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
				const newest = [...view.messages.keys()].sort((a, b) => b - a).slice(0, FLAG_WINDOW);
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
		const cached = view.messages.get(Number(msg.uid));
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

/** Per Message-ID, the tracked folders holding it (with their flags). */
export type RemoteIndex = Map<string, Array<{ remoteName: string; flags: FlagState }>>;

export function indexViews(views: ReadonlyMap<string, FolderView>): RemoteIndex {
	const index: RemoteIndex = new Map();
	for (const [remoteName, view] of views) {
		for (const cached of view.messages.values()) {
			if (!cached.messageId) continue;
			const entry = index.get(cached.messageId) ?? [];
			entry.push({ remoteName, flags: cached.flags });
			index.set(cached.messageId, entry);
		}
	}
	return index;
}

export interface DecideInput {
	index: RemoteIndex;
	/** Tracked remote folders, best first — the order a moved message's new home is chosen in. */
	order: ReadonlyArray<string>;
	/** Folders that are synced but not kept as views (All Mail). */
	untracked: ReadonlySet<string>;
	/** Flag changes read from the untracked folders this cycle. */
	untrackedFlags: ReadonlyMap<string, FlagState>;
}

export interface Decision {
	observations: RemoteObservation[];
	/** Local messages in no tracked folder, to look for in All Mail before judging. */
	unplaced: LocalMessageRow[];
}

/** Compare local messages with the provider's views. */
export function decide(rows: ReadonlyArray<LocalMessageRow>, input: DecideInput): Decision {
	const observations = new Map<string, RemoteObservation>();
	const unplaced: LocalMessageRow[] = [];
	for (const row of rows) {
		if (row.remoteName === null) continue;
		const locations = input.index.get(row.messageId) ?? [];
		const held = input.order.filter((name) => locations.some((l) => l.remoteName === name));
		const observation: RemoteObservation = { messageId: row.messageId };

		if (!held.includes(row.remoteName)) {
			if (held.length > 0) observation.remoteFolders = held;
			// Sent and Drafts hold mail Owlat wrote itself, which the provider may
			// never have had; an absence there proves nothing.
			else if (
				!input.untracked.has(row.remoteName) &&
				row.role !== 'sent' &&
				row.role !== 'drafts'
			) {
				unplaced.push(row);
			}
		}

		const remoteFlags = input.untracked.has(row.remoteName)
			? input.untrackedFlags.get(row.messageId)
			: (locations.find((l) => l.remoteName === row.remoteName) ?? locations[0])?.flags;
		if (remoteFlags && !sameFlags(remoteFlags, row.flags)) observation.flags = remoteFlags;

		if (observation.remoteFolders || observation.flags) {
			observations.set(row.messageId, { ...observations.get(row.messageId), ...observation });
		}
	}
	return { observations: [...observations.values()], unplaced };
}

export interface ReconcileDeps {
	client: RemoteStateClient;
	/** Tracked folders, best first. */
	tracked: ReadonlyArray<string>;
	/** Gmail's All Mail, when the account has one. */
	allMail: string | null;
	views: Map<string, FolderView>;
	allMailCursor: ModseqCursor;
	isAligned: boolean;
	/** Compare every local message, not only the changed ones. */
	forceFull: boolean;
	listLocal(cursor: string | null): Promise<{
		page: LocalMessageRow[];
		isDone: boolean;
		continueCursor: string;
	}>;
	lookupLocal(messageIds: string[]): Promise<LocalMessageRow[]>;
	apply(observations: RemoteObservation[]): Promise<void>;
	markAligned(): Promise<void>;
	isStopped(): boolean;
}

/**
 * One reconcile pass. `full`: it compared every local message; `completed`: it
 * ran to the end rather than stopping for a lost connection.
 */
export async function reconcile(
	deps: ReconcileDeps
): Promise<{ full: boolean; completed: boolean }> {
	const changed = new Set<string>();
	const vanished = new Set<string>();
	let rebuilt = false;
	// A folder the provider no longer lists was renamed or deleted there: what it
	// held has left it, and is looked for wherever it went (or reported gone).
	for (const [name, view] of deps.views) {
		if (deps.tracked.includes(name)) continue;
		deps.views.delete(name);
		for (const cached of view.messages.values()) {
			if (!cached.messageId) continue;
			vanished.add(cached.messageId);
			changed.add(cached.messageId);
		}
	}
	for (const name of deps.tracked) {
		if (deps.isStopped()) return { full: false, completed: false };
		const view = deps.views.get(name) ?? new FolderView();
		deps.views.set(name, view);
		const result = await refreshFolder(deps.client, name, view);
		for (const id of result.changed) changed.add(id);
		for (const id of result.vanished) vanished.add(id);
		rebuilt ||= result.rebuilt;
	}
	const untrackedFlags = deps.allMail
		? await readChangedFlags(deps.client, deps.allMail, deps.allMailCursor)
		: new Map<string, FlagState>();
	for (const id of untrackedFlags.keys()) changed.add(id);

	const input: DecideInput = {
		index: indexViews(deps.views),
		order: deps.tracked,
		untracked: new Set(deps.allMail ? [deps.allMail] : []),
		untrackedFlags,
	};
	let confirmsLeft = MAX_CONFIRMS_PER_CYCLE;
	const settle = async (rows: LocalMessageRow[]) => {
		const { observations, unplaced } = decide(rows, input);
		const checked = unplaced.slice(0, confirmsLeft);
		confirmsLeft -= checked.length;
		const inAllMail = deps.allMail
			? await findInFolder(
					deps.client,
					deps.allMail,
					checked.map((r) => r.messageId)
				)
			: new Set<string>();
		for (const row of checked) {
			if (inAllMail.has(row.messageId)) {
				observations.push({ messageId: row.messageId, remoteFolders: [deps.allMail!] });
			} else if (vanished.has(row.messageId)) {
				// It left a folder this cycle and is nowhere now: deleted on the provider.
				observations.push({ messageId: row.messageId, isGone: true });
			}
		}
		for (const chunk of chunks(observations, APPLY_CHUNK)) await deps.apply(chunk);
	};

	const full = deps.forceFull || rebuilt || !deps.isAligned;
	if (full) {
		let cursor: string | null = null;
		for (;;) {
			if (deps.isStopped()) return { full: false, completed: false };
			const page = await deps.listLocal(cursor);
			await settle(page.page);
			if (page.isDone) break;
			cursor = page.continueCursor;
		}
		if (!deps.isAligned) await deps.markAligned();
	} else {
		for (const ids of chunks([...changed], LOOKUP_CHUNK)) {
			if (deps.isStopped()) return { full: false, completed: false };
			await settle(await deps.lookupLocal(ids));
		}
	}
	return { full, completed: true };
}
