import type { OptimisticLocalStore, OptimisticUpdate } from 'convex/browser';
import type { FunctionArgs, FunctionReference } from 'convex/server';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { applyMailChange, patchSidebarThreads, patchThreadDoc } from './mailChange';
import {
	folderRole,
	isSnoozed,
	knownMailRows,
	roleFolderId,
	UNKNOWN_FOLDER,
	type MailRowFacts,
	type MailRowPatch,
} from './mailRows';

/**
 * Native Convex optimistic updates for the Postbox mail mutations (plan 2.2).
 *
 * Each one mirrors what its server mutation does to the rows and counts the
 * client has cached, so a star, a mark-read, an archive or a label lands on
 * every mounted surface in the same frame as the click: the list, the open
 * conversation, the folder rail and its badges, the split-inbox section counts
 * and the sidebar's inbox group. Convex drops the patch when the server's
 * result arrives or the write fails, so there is no rollback code and the
 * error toast stays with `useBackendOperation`.
 *
 * Pass one as the operation's `optimisticUpdate`
 * (`useBackendOperation(api.mail.messageActions.setStar, { optimisticUpdate: optimisticSetStar })`).
 */

type Updater<M extends FunctionReference<'mutation'>> = OptimisticUpdate<FunctionArgs<M>>;

const byIds = (ids: readonly string[]) => {
	const wanted = new Set(ids);
	return (row: MailRowFacts) => wanted.has(row._id);
};

function patchIds(store: OptimisticLocalStore, ids: readonly string[], patch: MailRowPatch): void {
	applyMailChange(store, { select: byIds(ids), patch: () => patch });
}

// ── Flags ─────────────────────────────────────────────────────────

export const optimisticSetFlags: Updater<typeof api.mail.messageActions.setFlags> = (
	store,
	args
) => {
	const patch: MailRowPatch = {};
	if (args.seen !== undefined) patch.flagSeen = args.seen;
	if (args.flagged !== undefined) patch.flagFlagged = args.flagged;
	if (args.answered !== undefined) patch.flagAnswered = args.answered;
	if (Object.keys(patch).length === 0) return;
	patchIds(store, args.messageIds, patch);
};

export const optimisticMarkRead: Updater<typeof api.mail.messageActions.markRead> = (store, args) =>
	patchIds(store, [args.messageId], { flagSeen: args.seen });

export const optimisticSetStar: Updater<typeof api.mail.messageActions.setStar> = (store, args) =>
	patchIds(store, [args.messageId], { flagFlagged: args.starred });

/**
 * Every message of the thread changes, including the ones no view has loaded,
 * so the thread doc and the sidebar row are set outright rather than counted.
 */
export const optimisticMarkThreadRead: Updater<typeof api.mail.messageActions.markThreadRead> = (
	store,
	args
) => {
	applyMailChange(store, {
		select: (row) => row.threadId === args.threadId,
		patch: () => ({ flagSeen: args.seen }),
	});
	patchThreadDoc(store, args.threadId, (thread) => {
		const unreadCount = args.seen ? 0 : thread.messageCount;
		return thread.unreadCount === unreadCount ? thread : { ...thread, unreadCount };
	});
	patchSidebarThreads(store, (row) =>
		row.threadId !== args.threadId || row.isUnread === !args.seen
			? row
			: { ...row, isUnread: !args.seen }
	);
};

// ── Moves ─────────────────────────────────────────────────────────

/**
 * Move rows to `target` (resolved per row, since archive and trash pick the
 * folder by the row's mailbox). A row already in the target stays put, as on
 * the server; an unresolvable target still takes the row out of its folder.
 */
function moveRows(
	store: OptimisticLocalStore,
	messageIds: readonly string[],
	target: (row: MailRowFacts) => Id<'mailFolders'> | null
): void {
	const selected = byIds(messageIds);
	applyMailChange(store, {
		select: (row) => selected(row) && target(row) !== row.folderId,
		patch: (row) => ({ folderId: target(row) ?? UNKNOWN_FOLDER }),
	});
}

export const optimisticMove: Updater<typeof api.mail.messageActions.move> = (store, args) =>
	moveRows(store, args.messageIds, () => args.targetFolderId);

export const optimisticArchive: Updater<typeof api.mail.messageActions.archive> = (store, args) =>
	moveRows(store, args.messageIds, (row) => roleFolderId(store, row.mailboxId, 'archive'));

export const optimisticTrash: Updater<typeof api.mail.messageActions.trash> = (store, args) =>
	moveRows(store, args.messageIds, (row) => roleFolderId(store, row.mailboxId, 'trash'));

// ── Snooze ────────────────────────────────────────────────────────

export const optimisticSnooze: Updater<typeof api.mail.snooze.snooze> = (store, args) =>
	patchIds(store, [args.messageId], { snoozedUntil: args.until });

export const optimisticSnoozeUntilReply: Updater<typeof api.mail.snooze.snoozeUntilReply> = (
	store,
	args
) => patchIds(store, [args.messageId], { snoozedUntil: args.capUntil, isSnoozeUntilReply: true });

export const optimisticSnoozeMany: Updater<typeof api.mail.snooze.snoozeMany> = (store, args) =>
	patchIds(store, args.messageIds, { snoozedUntil: args.until });

/**
 * The server defers the thread's inbox mail (and re-times mail already
 * snoozed). A row's folder counts as the inbox when the cached folder list
 * says so, or, before it has loaded, when the split inbox or an inbox view
 * lists the row.
 */
export const optimisticSnoozeThread: Updater<typeof api.mail.snooze.snoozeThread> = (
	store,
	args
) => {
	const now = Date.now();
	const inboxRows = inboxListedIds(store);
	applyMailChange(store, {
		select: (row) =>
			row.threadId === args.threadId && (isSnoozed(row, now) || isInboxRow(store, row, inboxRows)),
		patch: () => ({ snoozedUntil: args.until }),
	});
};

function isInboxRow(
	store: OptimisticLocalStore,
	row: MailRowFacts,
	inboxRows: ReadonlySet<string>
): boolean {
	const role = folderRole(store, row.folderId);
	return role === null ? inboxRows.has(row._id) : role === 'inbox';
}

function inboxListedIds(store: OptimisticLocalStore): Set<string> {
	const ids = new Set<string>();
	for (const { value } of store.getAllQueries(api.mail.sections.listSections)) {
		for (const section of value?.sections ?? []) for (const m of section.messages) ids.add(m._id);
	}
	for (const { args, value } of store.getAllQueries(api.mail.mailbox.queries.listMessages)) {
		if (args.folderRole !== 'inbox') continue;
		for (const m of value?.messages ?? []) ids.add(m._id);
	}
	return ids;
}

// ── Labels on messages ────────────────────────────────────────────

function withLabel(labelIds: Id<'mailLabels'>[], labelId: Id<'mailLabels'>, add: boolean) {
	if (add) return labelIds.includes(labelId) ? labelIds : [...labelIds, labelId];
	return labelIds.includes(labelId) ? labelIds.filter((id) => id !== labelId) : labelIds;
}

/**
 * Label (or unlabel) the selected rows, then carry the change to the thread
 * doc: adding always labels the thread; removing unlabels it once no known
 * message of the thread keeps the label (`labels.reconcileThreadLabel`).
 */
function setLabel(
	store: OptimisticLocalStore,
	select: (row: MailRowFacts) => boolean,
	labelId: Id<'mailLabels'>,
	add: boolean,
	threadId?: Id<'mailThreads'>
): void {
	const transitions = applyMailChange(store, {
		select,
		patch: (row) => ({ labelIds: withLabel(row.labelIds, labelId, add) }),
	});
	const threads = new Set(transitions.map((t) => t.before.threadId));
	// A thread-wide write reaches the thread doc even when no message is loaded.
	if (threadId) threads.add(threadId);
	if (threads.size === 0) return;
	const known = knownMailRows(store);
	for (const touched of threads) {
		const keeps = [...known.values()].some(
			(row) => row.threadId === touched && row.labelIds.includes(labelId)
		);
		patchThreadDoc(store, touched, (thread) => {
			const labelIds = withLabel(thread.labelIds, labelId, add || keeps);
			return labelIds === thread.labelIds ? thread : { ...thread, labelIds };
		});
	}
}

export const optimisticToggleLabelOnMessage: Updater<typeof api.mail.labels.toggleOnMessage> = (
	store,
	args
) => setLabel(store, byIds([args.messageId]), args.labelId, args.add);

export const optimisticSetLabelOnMessages: Updater<typeof api.mail.labels.setOnMessages> = (
	store,
	args
) => setLabel(store, byIds(args.messageIds), args.labelId, args.add);

export const optimisticToggleLabelOnThread: Updater<typeof api.mail.labels.toggleOnThread> = (
	store,
	args
) =>
	setLabel(store, (row) => row.threadId === args.threadId, args.labelId, args.add, args.threadId);
