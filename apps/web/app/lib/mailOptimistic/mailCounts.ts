import type { OptimisticLocalStore } from 'convex/browser';
import { api } from '@owlat/api';
import { updateQueries } from '~/lib/optimisticStore';
import { isSnoozed, mergeRowPatch, UNKNOWN_FOLDER, type MailRowFacts } from './mailRows';

/**
 * The counts a mail mutation moves, derived from its row transitions the way
 * the server derives them (`mail/messageActions.ts`, `mail/snooze.ts`,
 * `mail/messageCounters.ts`), and written into the cached count queries:
 * folder `unseenCount` / `totalCount` (`listFolders`), the mailbox switcher's
 * inbox badge (`accessible`), label unread counts (`labels.unreadCounts`),
 * split-inbox section counts (`listSections`) and the sidebar's inbox group
 * (`today.mailbox.sidebarThreads`).
 *
 * Only rows the local store knows are counted. A thread-wide write that also
 * reaches rows no view has loaded corrects the rest when the server answers,
 * which is also when Convex drops this layer.
 */

/** One row before and after the mutation. */
export interface MailTransition {
	before: MailRowFacts;
	after: MailRowFacts;
}

type Deltas = Map<string, number>;

function bump(map: Deltas, key: string, by: number): void {
	if (by === 0) return;
	map.set(key, (map.get(key) ?? 0) + by);
}

function nested(map: Map<string, Deltas>, key: string): Deltas {
	let inner = map.get(key);
	if (!inner) {
		inner = new Map();
		map.set(key, inner);
	}
	return inner;
}

/** What the transitions do to each count, keyed the way the counts are. */
export interface MailCountDeltas {
	folderUnseen: Deltas;
	folderTotal: Deltas;
	/** mailboxId → labelId → delta. */
	labelUnread: Map<string, Deltas>;
	/** folderId → section bucket (`''` for an unstamped row) → delta. */
	sectionUnread: Map<string, Deltas>;
}

/** Folder `unseenCount` counts unread mail that is not snoozed. */
const countsUnseen = (row: MailRowFacts, now: number) => !row.flagSeen && !isSnoozed(row, now);
/** Label counters count unread mail anywhere, snoozed included. */
const labelBuckets = (row: MailRowFacts) => (row.flagSeen ? [] : row.labelIds);
/** Section counters count unread mail whose snooze column is empty. */
const sectionBuckets = (row: MailRowFacts) =>
	row.flagSeen || row.snoozedUntil != null ? [] : [row.pinnedSection || ''];

export function countDeltas(transitions: MailTransition[], now: number): MailCountDeltas {
	const deltas: MailCountDeltas = {
		folderUnseen: new Map(),
		folderTotal: new Map(),
		labelUnread: new Map(),
		sectionUnread: new Map(),
	};
	for (const { before, after } of transitions) {
		if (before.folderId !== after.folderId) {
			bump(deltas.folderTotal, before.folderId, -1);
			bump(deltas.folderTotal, after.folderId, 1);
		}
		if (countsUnseen(before, now)) bump(deltas.folderUnseen, before.folderId, -1);
		if (countsUnseen(after, now)) bump(deltas.folderUnseen, after.folderId, 1);

		const labels = nested(deltas.labelUnread, before.mailboxId);
		for (const labelId of labelBuckets(before)) bump(labels, labelId, -1);
		for (const labelId of labelBuckets(after)) bump(labels, labelId, 1);

		for (const bucket of sectionBuckets(before)) {
			bump(nested(deltas.sectionUnread, before.folderId), bucket, -1);
		}
		for (const bucket of sectionBuckets(after)) {
			bump(nested(deltas.sectionUnread, after.folderId), bucket, 1);
		}
	}
	return deltas;
}

/**
 * The transitions a change makes to the rows the store knows. `after` keeps the
 * real destination even when it is {@link UNKNOWN_FOLDER}, so the source folder
 * still loses the row; no cached folder carries that id, so nothing gains it.
 */
export function transitionsFor(
	known: Map<string, MailRowFacts>,
	select: (row: MailRowFacts) => boolean,
	patch: (row: MailRowFacts) => Partial<MailRowFacts>
): MailTransition[] {
	const transitions: MailTransition[] = [];
	for (const before of known.values()) {
		if (!select(before)) continue;
		const rowPatch = patch(before);
		const merged = mergeRowPatch(before, rowPatch);
		const after =
			rowPatch.folderId === UNKNOWN_FOLDER ? { ...merged, folderId: UNKNOWN_FOLDER } : merged;
		if (after !== before) transitions.push({ before, after });
	}
	return transitions;
}

const clamp = (n: number) => Math.max(0, n);

/** The inbox folder id of every mailbox whose folder list is cached. */
export function inboxFolders(store: OptimisticLocalStore): Map<string, string> {
	const inboxes = new Map<string, string>();
	for (const { args, value } of store.getAllQueries(api.mail.mailbox.queries.listFolders)) {
		const inbox = value?.find((folder) => folder.role === 'inbox');
		if (inbox) inboxes.set(args.mailboxId, inbox._id);
	}
	return inboxes;
}

/** Write `deltas` into every cached count query. */
export function applyCountDeltas(store: OptimisticLocalStore, deltas: MailCountDeltas): void {
	updateQueries(store, api.mail.mailbox.queries.listFolders, (folders) => {
		let changed = false;
		const next = folders.map((folder) => {
			const unseen = deltas.folderUnseen.get(folder._id) ?? 0;
			const total = deltas.folderTotal.get(folder._id) ?? 0;
			if (unseen === 0 && total === 0) return folder;
			changed = true;
			return {
				...folder,
				unseenCount: clamp(folder.unseenCount + unseen),
				totalCount: clamp(folder.totalCount + total),
			};
		});
		return changed ? next : folders;
	});

	const inboxes = inboxFolders(store);
	const inboxDelta = (mailboxId: string) => {
		const inbox = inboxes.get(mailboxId);
		return inbox ? (deltas.folderUnseen.get(inbox) ?? 0) : 0;
	};

	updateQueries(store, api.mail.mailbox.queries.accessible, (rows) => {
		let changed = false;
		const next = rows.map((row) => {
			const delta = inboxDelta(row.mailboxId);
			if (delta === 0) return row;
			changed = true;
			return { ...row, unread: clamp(row.unread + delta) };
		});
		return changed ? next : rows;
	});

	updateQueries(store, api.today.mailbox.sidebarThreads, (value, args) => {
		const delta = inboxDelta(args.mailboxId);
		if (!value || delta === 0) return value;
		return { ...value, unread: clamp(value.unread + delta) };
	});

	updateQueries(store, api.mail.labels.unreadCounts, (value, args) => {
		const labelDeltas = deltas.labelUnread.get(args.mailboxId);
		if (!labelDeltas || ![...labelDeltas.values()].some((delta) => delta !== 0)) return value;
		const counts: Record<string, number> = { ...value.counts };
		for (const [labelId, delta] of labelDeltas) {
			const next = (counts[labelId] ?? 0) + delta;
			// Sparse, like the server's record: no unread mail means no key.
			if (next > 0) counts[labelId] = next;
			else delete counts[labelId];
		}
		return { ...value, counts };
	});

	updateQueries(store, api.mail.sections.listSections, (value, args) => {
		const folderId =
			args.folderId ??
			inboxes.get(args.mailboxId) ??
			value.sections.flatMap((s) => s.messages)[0]?.folderId;
		const buckets = folderId ? deltas.sectionUnread.get(folderId) : undefined;
		if (!buckets || buckets.size === 0) return value;
		const rendered = new Set(value.sections.flatMap((s) => (s.name === null ? [] : [s.name])));
		let changed = false;
		const sections = value.sections.map((section) => {
			// A capped count is a floor from the fallback scan; leave it alone.
			if (section.isUnreadCapped) return section;
			let delta = 0;
			for (const [bucket, by] of buckets) {
				// "Everything else" holds unstamped rows and every name no rendered
				// section carries (`sections.belongsToRemainder`).
				const inSection = section.name === null ? !rendered.has(bucket) : bucket === section.name;
				if (inSection) delta += by;
			}
			if (delta === 0) return section;
			changed = true;
			return { ...section, unreadCount: clamp(section.unreadCount + delta) };
		});
		return changed ? { ...value, sections } : value;
	});
}
