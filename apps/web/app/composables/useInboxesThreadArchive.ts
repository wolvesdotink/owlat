/**
 * Archive on the all-inboxes list (`/dashboard/inboxes`, where Today's "Filed
 * away" mailbox tiles land): a row's hover Archive button, and a sweep from it
 * across the rows below or above.
 *
 * A row there is a CONVERSATION, possibly from any of the viewer's mailboxes,
 * so the verb is `archiveThreads` on the row's thread id, never a stand-in
 * message id: every Inbox copy of the thread moves, each to its own mailbox's
 * Archive. Team-inbox rows carry no archive target and are skipped by a sweep.
 * Rows hide at once, come back if the call fails or the conversation stays in
 * the Inbox, and one "Undo" moves every archived message back.
 */

import { computed, type Ref } from 'vue';
import type { FunctionArgs } from 'convex/server';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { optimisticMove } from '~/lib/mailOptimistic/mailUpdaters';
import { usePostboxOptimisticHide } from './postbox/usePostboxOptimisticHide';
import { usePostboxTriageUndo } from './postbox/usePostboxTriageUndo';
import { usePostboxSweep } from './postbox/usePostboxSweep';

/** What archiving a row acts on; null for a row that has no archive (a team-inbox thread). */
export type InboxesArchiveTarget = { threadId: Id<'mailThreads'> } | null;

interface ArchivableRow {
	key: string;
	archive: InboxesArchiveTarget;
}

/** `archiveThreads` refuses more than this per call; a longer sweep is split. */
const THREADS_PER_CALL = 100;

/** One conversation for `archiveThreads`, with where to resume it if a call left it unfinished. */
type ThreadRequest = FunctionArgs<typeof api.mail.threadArchive.archiveThreads>['threads'][number];

export function useInboxesThreadArchive<R extends ArchivableRow>(args: {
	rows: Ref<R[]>;
	listEl: Ref<HTMLElement | null | undefined>;
	/** The list's filters; a change mid-sweep cancels it. */
	scopeKey: () => unknown;
}) {
	const { t } = useI18n();
	const triageUndo = usePostboxTriageUndo();
	const archiveOp = useBackendOperation(api.mail.threadArchive.archiveThreads, {
		label: () => t('dashboard.inboxes.archiveOperation'),
	});
	const moveOp = useBackendOperation(api.mail.messageActions.move, {
		label: () => t('dashboard.inboxes.archiveUndoOperation'),
		optimisticUpdate: optimisticMove,
	});

	const keyed = computed(() => args.rows.value.map((row) => ({ _id: row.key, row })));
	const { visible: visibleKeyed, hide, unhide } = usePostboxOptimisticHide(keyed);
	const visible = computed(() => visibleKeyed.value.map((entry) => entry.row));
	const byKey = computed(() => new Map(args.rows.value.map((row) => [row.key, row])));

	/**
	 * Archive the rows `keys` name (those with a target), hiding them while the
	 * calls run. A call takes at most {@link THREADS_PER_CALL} conversations and
	 * reads a bounded amount of mail, handing back the conversations it did not
	 * finish with where to resume; those go round again until every one is done,
	 * so a long conversation is archived whole.
	 *
	 * Settling, a row stays hidden only if its conversation has left the Inbox
	 * (the list will drop it). A row whose call failed, or whose conversation
	 * still holds Inbox mail (snoozed, or nothing to archive), comes back: the
	 * list keeps it, and the optimistic hide only lets go of rows that leave.
	 */
	async function archiveRows(keys: readonly string[]): Promise<boolean> {
		const keyOf = new Map<Id<'mailThreads'>, string>();
		for (const key of keys) {
			const target = byKey.value.get(key)?.archive;
			if (target && !keyOf.has(target.threadId)) keyOf.set(target.threadId, key);
		}
		if (keyOf.size === 0) return false;
		for (const key of keyOf.values()) hide(key);

		let queue: ThreadRequest[] = [...keyOf.keys()].map((threadId) => ({ threadId }));
		const moved: { messageId: Id<'mailMessages'>; sourceFolderId: Id<'mailFolders'> }[] = [];
		const archived = new Set<Id<'mailThreads'>>();
		const gone = new Set<Id<'mailThreads'>>();
		let isAllLanded = true;
		while (queue.length > 0) {
			const batch = queue.slice(0, THREADS_PER_CALL);
			queue = queue.slice(THREADS_PER_CALL);
			const outcome = await archiveOp.run({ threads: batch });
			if (!outcome.ok) {
				isAllLanded = false;
				continue;
			}
			moved.push(...outcome.result.moved);
			for (const thread of outcome.result.threads) {
				if (thread.moved > 0) archived.add(thread.threadId);
				if (!thread.isDone) {
					queue.push(
						thread.from
							? { threadId: thread.threadId, from: thread.from }
							: { threadId: thread.threadId }
					);
				} else if (thread.hasLeftInbox) {
					gone.add(thread.threadId);
				}
			}
		}
		for (const [threadId, key] of keyOf) if (!gone.has(threadId)) unhide(key);

		if (moved.length > 0) {
			triageUndo.registerMoveBack({
				label: t('dashboard.inboxes.archivedUndo', { count: archived.size }, archived.size),
				kind: 'archived',
				moved,
				runMove: (move) => moveOp.run(move),
				after: () => {
					for (const key of keyOf.values()) unhide(key);
				},
			});
		}
		return isAllLanded;
	}

	const sweep = usePostboxSweep({
		orderedIds: () => visible.value.map((row) => row.key),
		listEl: () => args.listEl.value,
		// No selection on this list: the only sweep is Archive.
		isSelected: () => false,
		canApply: (mark, _originId, key) =>
			mark === 'archive' && Boolean(byKey.value.get(key)?.archive),
		scopeKey: args.scopeKey,
		onCommit: ({ ids }) => void archiveRows(ids),
	});

	return {
		/** The rows to render: the source rows minus those an archive in flight has hidden. */
		visible,
		archiveRow: (row: R) => archiveRows([row.key]),
		sweep,
	};
}
