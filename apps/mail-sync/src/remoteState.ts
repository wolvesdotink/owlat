/**
 * Remote → local change sync: noticing what happened on the provider to mail
 * Owlat already has, and reporting it (`apps/api/convex/mail/external/remoteState.ts`
 * applies it).
 *
 * Every synced folder keeps a view in memory (folderView.ts) — UID →
 * Message-ID + flags. Each cycle refreshes it cheaply: `UID SEARCH UID n:*`
 * above the highest UID it knows finds what arrived (only the arrivals'
 * Message-ID headers are fetched), and flags come from `CHANGEDSINCE` where the
 * server has CONDSTORE, else from the newest messages. What LEFT a folder needs
 * a census — `UID SEARCH ALL` compared with the view — which runs only when
 * something says it may have: the folder's message count no longer matches the
 * view (UIDs only grow, so with every arrival accounted for, an equal count
 * means nothing left), a known expunge, a reconnect, a UIDVALIDITY reset, a
 * full reconcile, and at the latest every CENSUS_INTERVAL_MS as a safety net.
 * Asking the views, per Message-ID, which folders hold it now (each view
 * indexes its Message-IDs) tells a move — the local folder is not among them —
 * from a deletion: it left its folder and is nowhere.
 *
 * Normally only the Message-IDs that changed are looked up in Owlat. A FULL
 * reconcile compares every local message instead: after a restart (the views
 * are empty, so nothing is known to have changed), after a UIDVALIDITY reset,
 * while the account is not yet aligned, and every few hours as a safety net.
 *
 * The views die with the process, so after a restart nothing has been seen
 * leaving a folder. What survives is each local message's sighting: the folder,
 * UIDVALIDITY and UID it was last seen under on the provider, recorded at
 * ingest and refreshed here when it no longer matches. A message whose sighting
 * names a folder whose view, under the same UIDVALIDITY, has looked past that
 * UID and lacks it, has left that folder, even if no view saw it go. That is
 * how a deletion made while the worker was down is still mirrored.
 *
 * Gmail's All Mail holds every message and is not kept as a view: it is too
 * large, and a message in it alone is simply archived. Where a local message
 * seems to have vanished, All Mail is searched for it before anything is
 * reported, and its flag changes are read with CHANGEDSINCE.
 */

import {
	chunks,
	findInFolder,
	readChangedFlags,
	refreshFolder,
	sameFlags,
	CENSUS_INTERVAL_MS,
	type ModseqCursor,
	type RemoteStateClient,
} from './folderRefresh.js';
import { FolderView, type FlagState } from './folderView.js';
import type { FolderRole } from './folders.js';

export {
	canonicalMessageId,
	parseMessageIdHeader,
	refreshFolder,
	CENSUS_INTERVAL_MS,
	type ModseqCursor,
	type RefreshResult,
	type RemoteStateClient,
} from './folderRefresh.js';
export { FolderView, type FlagState };

/**
 * All Mail look-ups per cycle; the rest stay in `pending` for the next one.
 * Without All Mail there is nothing to look up, and no limit.
 */
const MAX_CONFIRMS_PER_CYCLE = 500;
/** Local messages per page of a full reconcile. */
export const LOCAL_PAGE = 500;
const LOOKUP_CHUNK = 200;
const APPLY_CHUNK = 100;

/** Where the provider was seen holding a message: the evidence that it once had it. */
export interface RemoteSighting {
	remoteName: string;
	uidValidity: number;
	uid: number;
}

/** One local message as `listLocalMessages` / `lookupLocalMessages` return it. */
export interface LocalMessageRow {
	messageId: string;
	/** Remote folder the local folder syncs with; null for a local-only folder. */
	remoteName: string | null;
	role: FolderRole | null;
	flags: FlagState;
	/** Where the provider was last seen holding it; absent if it never was (or not yet). */
	sighting?: RemoteSighting | null;
}

/** What `applyRemoteObservations` takes. */
export interface RemoteObservation {
	messageId: string;
	remoteFolders?: string[];
	isGone?: boolean;
	flags?: FlagState;
	/** Where the tracked folders hold it now; each local copy records its own folder's. */
	sightings?: RemoteSighting[];
	/** Drop the recorded sightings: a merge found the message in no synced folder. */
	forgetSightings?: boolean;
}

/** Per Message-ID, the tracked folders holding it (with their flags). */
export interface RemoteIndex {
	get(messageId: string): ReadonlyArray<{ remoteName: string; flags: FlagState }> | undefined;
}

/** Sightings read off the views. */
export interface SightingIndex {
	/** Where `remoteName`'s view holds `messageId` now. */
	locate(remoteName: string, messageId: string): RemoteSighting | undefined;
	/** The sighted folder's view, under the same UIDVALIDITY, knows the message has left it. */
	hasLeft(sighting: RemoteSighting): boolean;
}

/**
 * The views as a RemoteIndex, answered per question from each view's own
 * Message-ID index — nothing account-wide is rebuilt per reconcile.
 */
export function indexViews(views: ReadonlyMap<string, FolderView>): RemoteIndex & SightingIndex {
	const uidValidityOf = (view: FolderView | undefined) =>
		view?.uidValidity == null ? null : Number(view.uidValidity);
	return {
		get(messageId) {
			const held: Array<{ remoteName: string; flags: FlagState }> = [];
			for (const [remoteName, view] of views) {
				const flags = view.flagsOf(messageId);
				if (flags) held.push({ remoteName, flags });
			}
			return held.length > 0 ? held : undefined;
		},
		locate(remoteName, messageId) {
			const view = views.get(remoteName);
			const uidValidity = uidValidityOf(view);
			const uid = view?.uidOf(messageId);
			return uidValidity === null || uid === undefined
				? undefined
				: { remoteName, uidValidity, uid };
		},
		hasLeft(sighting) {
			const view = views.get(sighting.remoteName);
			return (
				view !== undefined &&
				uidValidityOf(view) === sighting.uidValidity &&
				view.hasLeft(sighting.uid)
			);
		},
	};
}

function sameSighting(a: RemoteSighting | undefined, b: RemoteSighting | null | undefined) {
	return a?.remoteName === b?.remoteName && a?.uidValidity === b?.uidValidity && a?.uid === b?.uid;
}

export interface DecideInput {
	index: RemoteIndex;
	/** Tracked remote folders, best first — the order a moved message's new home is chosen in. */
	order: ReadonlyArray<string>;
	/** Folders that are synced but not kept as views (All Mail). */
	untracked: ReadonlySet<string>;
	/** Flag changes read from the untracked folders this cycle. */
	untrackedFlags: ReadonlyMap<string, FlagState>;
	/** Without it, no sightings are reported. */
	sightings?: SightingIndex;
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

		// Sent and Drafts hold mail Owlat wrote itself, which the provider may
		// never have had; an absence there proves nothing.
		const isOwnMail = row.role === 'sent' || row.role === 'drafts';
		if (!held.includes(row.remoteName)) {
			if (held.length > 0) observation.remoteFolders = held;
			else if (!input.untracked.has(row.remoteName) && !isOwnMail) unplaced.push(row);
		} else if (input.sightings && !isOwnMail) {
			// Written only when it moved on, so a settled mailbox costs no writes.
			const here = input.sightings.locate(row.remoteName, row.messageId);
			if (here && !sameSighting(here, row.sighting)) {
				const sightings = observations.get(row.messageId)?.sightings ?? [];
				if (!sightings.some((s) => s.remoteName === here.remoteName)) sightings.push(here);
				observation.sightings = sightings;
			}
		}

		const remoteFlags = input.untracked.has(row.remoteName)
			? input.untrackedFlags.get(row.messageId)
			: (locations.find((l) => l.remoteName === row.remoteName) ?? locations[0])?.flags;
		if (remoteFlags && !sameFlags(remoteFlags, row.flags)) observation.flags = remoteFlags;

		if (observation.remoteFolders || observation.flags || observation.sightings) {
			observations.set(row.messageId, { ...observations.get(row.messageId), ...observation });
		}
	}
	return { observations: [...observations.values()], unplaced };
}

/**
 * What a reconcile noticed on the provider but has not settled locally yet.
 * The views have already moved on, so a pass cut short (lost connection,
 * shutdown) hands this to the next one instead of forgetting that a message
 * left a folder or that a view was rebuilt. So does a pass that ran out of
 * All Mail look-ups, for the messages it could not check.
 */
export interface PendingChanges {
	changed: Set<string>;
	vanished: Set<string>;
	/** Flag changes read from the untracked folders (All Mail), whose cursor has moved on. */
	untrackedFlags: Map<string, FlagState>;
	rebuilt: boolean;
}

export function noPendingChanges(): PendingChanges {
	return { changed: new Set(), vanished: new Set(), untrackedFlags: new Map(), rebuilt: false };
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
	/** Clock for the census cadence (CENSUS_INTERVAL_MS); defaults to Date.now. */
	now?: () => number;
	/**
	 * Carried across passes. A pass that completes empties it, except for the
	 * messages it had no All Mail look-ups left for.
	 */
	pending?: PendingChanges;
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
	const pending = deps.pending ?? noPendingChanges();
	const { changed, vanished, untrackedFlags } = pending;
	// A folder the provider no longer lists was renamed or deleted there: what it
	// held has left it, and is looked for wherever it went (or reported gone).
	for (const [name, view] of deps.views) {
		if (deps.tracked.includes(name)) continue;
		deps.views.delete(name);
		for (const cached of view.messages()) {
			if (!cached.messageId) continue;
			vanished.add(cached.messageId);
			changed.add(cached.messageId);
		}
	}
	const now = (deps.now ?? Date.now)();
	for (const name of deps.tracked) {
		if (deps.isStopped()) return { full: false, completed: false };
		const view = deps.views.get(name) ?? new FolderView();
		deps.views.set(name, view);
		const census =
			deps.forceFull || !deps.isAligned || now - view.lastCensusAt >= CENSUS_INTERVAL_MS;
		// Recorded into `pending` as the view changes, so a refresh that throws
		// part-way still hands the next pass what it removed from the view.
		await refreshFolder(deps.client, name, view, { census, now, into: pending });
	}
	if (deps.allMail) {
		const read = await readChangedFlags(deps.client, deps.allMail, deps.allMailCursor);
		for (const [id, flags] of read) {
			untrackedFlags.set(id, flags);
			changed.add(id);
		}
	}

	const index = indexViews(deps.views);
	const input: DecideInput = {
		index,
		order: deps.tracked,
		untracked: new Set(deps.allMail ? [deps.allMail] : []),
		untrackedFlags,
		sightings: index,
	};
	let confirmsLeft = MAX_CONFIRMS_PER_CYCLE;
	// Candidates past the look-up budget. The views no longer hold them, so they
	// are handed to the next pass (with the evidence that they vanished) rather
	// than dropped with the rest of `pending`.
	const deferred: string[] = [];
	const settle = async (rows: LocalMessageRow[]) => {
		const { observations, unplaced } = decide(rows, input);
		if (deps.isAligned) {
			// Seen in a folder whose view now knows it is gone from there: it left,
			// even if it went while no view was watching (the worker was down).
			for (const row of unplaced) {
				if (row.sighting && index.hasLeft(row.sighting)) vanished.add(row.messageId);
			}
		}
		let checked = unplaced;
		if (deps.allMail) {
			// What left a folder is checked before what merely sits in none, so a
			// backlog of mail the provider never had cannot starve real deletions.
			unplaced.sort((a, b) => +vanished.has(b.messageId) - +vanished.has(a.messageId));
			checked = unplaced.slice(0, confirmsLeft);
			confirmsLeft -= checked.length;
			for (const row of unplaced.slice(checked.length)) deferred.push(row.messageId);
		}
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
				// It left a folder and is nowhere now: deleted on the provider.
				observations.push({ messageId: row.messageId, isGone: true });
			}
		}
		if (!deps.isAligned) {
			// A merge deletes nothing, so a sighting from before it must not delete
			// the message once the account is aligned either.
			for (const row of unplaced) {
				if (row.sighting && !inAllMail.has(row.messageId)) {
					observations.push({ messageId: row.messageId, forgetSightings: true });
				}
			}
		}
		for (const chunk of chunks(observations, APPLY_CHUNK)) await deps.apply(chunk);
	};

	const full = deps.forceFull || pending.rebuilt || !deps.isAligned;
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
	const stillVanished = deferred.filter((id) => vanished.has(id));
	changed.clear();
	vanished.clear();
	untrackedFlags.clear();
	pending.rebuilt = false;
	for (const id of deferred) changed.add(id);
	for (const id of stillVanished) vanished.add(id);
	return { full, completed: true };
}
