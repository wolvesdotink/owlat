import type { OptimisticLocalStore } from 'convex/browser';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@owlat/api';
import { updateQueries } from '~/lib/optimisticStore';
import {
	isSnoozed,
	knownMailRows,
	patchMailRowCaches,
	type MailRowChange,
	type MailRowFacts,
} from './mailRows';
import {
	applyCountDeltas,
	countDeltas,
	inboxFolders,
	transitionsFor,
	type MailTransition,
} from './mailCounts';

/**
 * The one entry point every mail updater goes through: apply a row change to
 * every cached copy of the rows, move the counts it moves, and update the
 * thread-level reads (the open conversation's thread doc, the sidebar's inbox
 * threads). Returns the transitions, for an updater with thread-level extras.
 */
export function applyMailChange(
	store: OptimisticLocalStore,
	change: MailRowChange
): MailTransition[] {
	const now = Date.now();
	const known = knownMailRows(store);
	const transitions = transitionsFor(known, change.select, change.patch);
	patchMailRowCaches(store, change, now);
	if (transitions.length === 0) return transitions;
	applyCountDeltas(store, countDeltas(transitions, now));
	applyThreadEffects(store, transitions, known, now);
	return transitions;
}

type ThreadMessages = NonNullable<
	FunctionReturnType<typeof api.mail.mailbox.messages.listThreadMessages>
>;
type ThreadDoc = NonNullable<ThreadMessages['thread']>;

/** Rewrite the thread doc of every cached `listThreadMessages` for `threadId`. */
export function patchThreadDoc(
	store: OptimisticLocalStore,
	threadId: string,
	patch: (thread: ThreadDoc) => ThreadDoc
): void {
	updateQueries(store, api.mail.mailbox.messages.listThreadMessages, (value) => {
		if (!value?.thread || value.thread._id !== threadId) return value;
		const thread = patch(value.thread);
		return thread === value.thread ? value : { ...value, thread };
	});
}

type SidebarThread = NonNullable<
	FunctionReturnType<typeof api.today.mailbox.sidebarThreads>
>['threads'][number];

/**
 * Rewrite the sidebar's inbox thread rows for the touched threads. Return
 * `null` to drop a row (the thread left the inbox).
 */
export function patchSidebarThreads(
	store: OptimisticLocalStore,
	patch: (row: SidebarThread, mailboxId: string) => SidebarThread | null
): void {
	updateQueries(store, api.today.mailbox.sidebarThreads, (value, args) => {
		if (!value) return value;
		let changed = false;
		const threads: SidebarThread[] = [];
		for (const row of value.threads) {
			const next = patch(row, args.mailboxId);
			if (next !== row) changed = true;
			if (next) threads.push(next);
		}
		return changed ? { ...value, threads } : value;
	});
}

const clamp = (n: number) => Math.max(0, n);

function groupByThread(transitions: MailTransition[]): Map<string, MailTransition[]> {
	const byThread = new Map<string, MailTransition[]>();
	for (const t of transitions) {
		const list = byThread.get(t.before.threadId) ?? [];
		list.push(t);
		byThread.set(t.before.threadId, list);
	}
	return byThread;
}

function applyThreadEffects(
	store: OptimisticLocalStore,
	transitions: MailTransition[],
	known: Map<string, MailRowFacts>,
	now: number
): void {
	const byThread = groupByThread(transitions);
	const after = new Map(known);
	for (const t of transitions) after.set(t.after._id, t.after);
	// Only the touched threads' rows are ever asked for; index them once.
	const threadRows = new Map<string, MailRowFacts[]>();
	for (const row of after.values()) {
		if (!byThread.has(row.threadId)) continue;
		const rows = threadRows.get(row.threadId) ?? [];
		rows.push(row);
		threadRows.set(row.threadId, rows);
	}
	const rowsOf = (threadId: string) => threadRows.get(threadId) ?? [];

	for (const [threadId, list] of byThread) {
		const unreadDelta = list.reduce(
			(sum, t) =>
				t.before.flagSeen === t.after.flagSeen ? sum : sum + (t.after.flagSeen ? -1 : 1),
			0
		);
		const flagMoved = list.some((t) => t.before.flagFlagged !== t.after.flagFlagged);
		if (unreadDelta === 0 && !flagMoved) continue;
		patchThreadDoc(store, threadId, (thread) => {
			const hasFlagged = flagMoved
				? rowsOf(threadId).some((row) => row.flagFlagged)
				: thread.hasFlagged;
			if (unreadDelta === 0 && hasFlagged === thread.hasFlagged) return thread;
			return { ...thread, unreadCount: clamp(thread.unreadCount + unreadDelta), hasFlagged };
		});
	}

	const inboxes = inboxFolders(store);
	patchSidebarThreads(store, (row, mailboxId) => {
		const list = byThread.get(row.threadId);
		if (!list) return row;
		const rows = rowsOf(row.threadId);
		if (leftInbox(list, rows, row.latestMessageId, inboxes.get(mailboxId) ?? null, now)) {
			return null;
		}
		if (!list.some((t) => t.before.flagSeen !== t.after.flagSeen)) return row;
		const isUnread = rows.some((r) => !r.flagSeen);
		return isUnread === row.isUnread ? row : { ...row, isUnread };
	});
}

/**
 * Whether a thread leaves the sidebar's inbox group: its newest message was
 * snoozed (the server hides those), or mail left the inbox and no row the
 * store knows is still there. Without a cached folder list the inbox is
 * unknown, and only the newest message leaving its folder counts.
 */
function leftInbox(
	list: MailTransition[],
	rows: MailRowFacts[],
	latestMessageId: string | null,
	inbox: string | null,
	now: number
): boolean {
	const latest = list.find((t) => t.before._id === latestMessageId);
	if (latest && isSnoozed(latest.after, now)) return true;
	if (!inbox) return latest !== undefined && latest.after.folderId !== latest.before.folderId;
	const inInbox = (row: MailRowFacts) => row.folderId === inbox && !isSnoozed(row, now);
	const movedOut = list.some((t) => inInbox(t.before) && !inInbox(t.after));
	return movedOut && !rows.some(inInbox);
}
