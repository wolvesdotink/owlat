import type { OptimisticLocalStore } from 'convex/browser';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { updateQueries } from '~/lib/optimisticStore';

/**
 * The message rows the Postbox keeps in the Convex local store, and how a
 * mail mutation's optimistic update rewrites them.
 *
 * One message can sit in several cached results at once: a folder page of
 * `listMessages`, a split-inbox section of `listSections`, a label view, the
 * open conversation (`listThreadMessages`) and the reader's `getMessage`. Each
 * of those carries the fields below (the slim list row of plan 2.3 and the full
 * message doc alike), so the updaters patch them through one walker and every
 * surface agrees the moment the mutation is sent.
 */

/** The fields of a message row the mail updaters read and write. */
export interface MailRowFacts {
	_id: Id<'mailMessages'>;
	mailboxId: Id<'mailboxes'>;
	folderId: Id<'mailFolders'>;
	threadId: Id<'mailThreads'>;
	flagSeen: boolean;
	flagFlagged: boolean;
	flagAnswered?: boolean;
	labelIds: Id<'mailLabels'>[];
	snoozedUntil?: number;
	isSnoozeUntilReply?: boolean;
	pinnedSection?: string;
}

/** What a mutation changes on a row. Keys left out stay as they are. */
export type MailRowPatch = Partial<
	Pick<
		MailRowFacts,
		| 'flagSeen'
		| 'flagFlagged'
		| 'flagAnswered'
		| 'labelIds'
		| 'folderId'
		| 'snoozedUntil'
		| 'isSnoozeUntilReply'
	>
>;

/** A change to a set of rows: which rows, and the patch for each. */
export interface MailRowChange {
	select: (row: MailRowFacts) => boolean;
	patch: (row: MailRowFacts) => MailRowPatch;
}

/**
 * Stand-in for a destination folder the local store cannot name (archive or
 * trash before the folder list has loaded). The row still leaves the folder
 * it was in; nothing is written into a folder nobody knows.
 */
export const UNKNOWN_FOLDER = '__optimistic_unknown_folder__' as Id<'mailFolders'>;

/** The server's snooze test (`lib/mailSnooze.isMessageSnoozed`). */
export function isSnoozed(row: { snoozedUntil?: number | null }, now: number): boolean {
	return row.snoozedUntil != null && row.snoozedUntil > now;
}

function sameValue(a: unknown, b: unknown): boolean {
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((value, index) => value === b[index]);
	}
	return Object.is(a, b);
}

/**
 * `row` with `patch` merged in, or `row` itself when nothing changes. A
 * destination of {@link UNKNOWN_FOLDER} is never written onto a row.
 */
export function mergeRowPatch<T extends MailRowFacts>(row: T, patch: MailRowPatch): T {
	let next: T | null = null;
	for (const key of Object.keys(patch) as (keyof MailRowPatch)[]) {
		const value = patch[key];
		if (key === 'folderId' && value === UNKNOWN_FOLDER) continue;
		if (sameValue(row[key], value)) continue;
		next ??= { ...row };
		(next as Record<string, unknown>)[key] = value;
	}
	return next ?? row;
}

/**
 * Whether a patched row still belongs in the view that listed it. Views never
 * gain rows optimistically (they are keyset pages, and an inserted row would
 * have no honest position), they only keep or lose them.
 */
type KeepRow = (before: MailRowFacts, after: MailRowFacts & { folderMoved: boolean }) => boolean;

/** A folder view: the row must stay in its folder and stay awake. */
const keepInFolder =
	(now: number): KeepRow =>
	(_before, after) =>
		!after.folderMoved && !isSnoozed(after, now);
/** A mailbox-wide view (the label and "all mail" pages): only a snooze hides it. */
const keepInMailbox =
	(now: number): KeepRow =>
	(_before, after) =>
		!isSnoozed(after, now);
/** The virtual Snoozed view lists exactly the snoozed rows. */
const keepIfSnoozed =
	(now: number): KeepRow =>
	(_before, after) =>
		isSnoozed(after, now);
/** The reader's own reads keep every row of the conversation. */
const keepAlways: KeepRow = () => true;

/**
 * Apply `change` to `rows`. Returns the same array when nothing changed, so
 * {@link updateQueries} leaves the cached result alone.
 */
export function rewriteRows<T extends MailRowFacts>(
	rows: T[],
	change: MailRowChange,
	keep: KeepRow
): T[] {
	let changed = false;
	const next: T[] = [];
	for (const row of rows) {
		if (!change.select(row)) {
			next.push(row);
			continue;
		}
		const patch = change.patch(row);
		const after = mergeRowPatch(row, patch);
		const folderMoved = patch.folderId !== undefined && patch.folderId !== row.folderId;
		if (!keep(row, { ...after, folderMoved })) {
			changed = true;
			continue;
		}
		if (after !== row) changed = true;
		next.push(after);
	}
	return changed ? next : rows;
}

/** Every loaded row of every row-bearing mail query, first copy per id. */
export function knownMailRows(store: OptimisticLocalStore): Map<string, MailRowFacts> {
	const rows = new Map<string, MailRowFacts>();
	const add = (list: readonly MailRowFacts[] | undefined) => {
		for (const row of list ?? []) if (!rows.has(row._id)) rows.set(row._id, row);
	};
	for (const { value } of store.getAllQueries(api.mail.mailbox.queries.listMessages)) {
		add(value?.messages);
	}
	for (const { value } of store.getAllQueries(api.mail.sections.listSections)) {
		for (const section of value?.sections ?? []) add(section.messages);
	}
	for (const { value } of store.getAllQueries(api.mail.mailbox.queries.listByLabel)) {
		add(value?.messages);
	}
	for (const { value } of store.getAllQueries(api.mail.mailbox.messages.listThreadMessages)) {
		add(value?.messages);
		add(value?.envelopes);
	}
	for (const { value } of store.getAllQueries(api.mail.mailbox.messages.getMessage)) {
		if (value) add([value]);
	}
	return rows;
}

/**
 * Rewrite every cached copy of the selected rows: patch them, and drop them
 * from the list views they no longer belong in.
 */
export function patchMailRowCaches(
	store: OptimisticLocalStore,
	change: MailRowChange,
	now: number
): void {
	updateQueries(store, api.mail.mailbox.queries.listMessages, (value, args) => {
		const keep =
			args.folderRole === 'snoozed'
				? keepIfSnoozed(now)
				: args.folderId || args.folderRole
					? keepInFolder(now)
					: keepInMailbox(now);
		const messages = rewriteRows(value.messages, change, keep);
		return messages === value.messages ? value : { ...value, messages };
	});

	updateQueries(store, api.mail.sections.listSections, (value) => {
		let changed = false;
		const sections = value.sections.map((section) => {
			const messages = rewriteRows(section.messages, change, keepInFolder(now));
			if (messages === section.messages) return section;
			changed = true;
			return { ...section, messages };
		});
		return changed ? { ...value, sections } : value;
	});

	updateQueries(store, api.mail.mailbox.queries.listByLabel, (value, args) => {
		const inMailbox = keepInMailbox(now);
		const keep: KeepRow = (before, after) =>
			inMailbox(before, after) && after.labelIds.includes(args.labelId);
		const messages = rewriteRows(value.messages, change, keep);
		return messages === value.messages ? value : { ...value, messages };
	});

	updateQueries(store, api.mail.mailbox.messages.listThreadMessages, (value) => {
		if (!value) return value;
		const messages = rewriteRows(value.messages, change, keepAlways);
		const envelopes = rewriteRows(value.envelopes, change, keepAlways);
		if (messages === value.messages && envelopes === value.envelopes) return value;
		return { ...value, messages, envelopes };
	});

	updateQueries(store, api.mail.mailbox.messages.getMessage, (value) => {
		if (!value || !change.select(value)) return value;
		return mergeRowPatch(value, change.patch(value));
	});
}

/** The folder with `role` in `mailboxId`, from the cached folder list. */
export function roleFolderId(
	store: OptimisticLocalStore,
	mailboxId: string,
	role: string
): Id<'mailFolders'> | null {
	const folders = store.getQuery(api.mail.mailbox.queries.listFolders, {
		mailboxId: mailboxId as Id<'mailboxes'>,
	});
	return folders?.find((folder) => folder.role === role)?._id ?? null;
}

/** The role of `folderId`, from the cached folder lists; null when unknown. */
export function folderRole(store: OptimisticLocalStore, folderId: string): string | null {
	for (const { value } of store.getAllQueries(api.mail.mailbox.queries.listFolders)) {
		const folder = value?.find((f) => f._id === folderId);
		if (folder) return folder.role ?? '';
	}
	return null;
}
