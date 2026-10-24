/**
 * Archive on the all-inboxes list (`/dashboard/inboxes`, where Today's "Filed
 * away" mailbox tiles land): a row's hover Archive button, and a sweep from it
 * across the rows below or above.
 *
 * A row there is a CONVERSATION, possibly from any of the viewer's mailboxes,
 * so the verb is `archiveThreads` on the row's thread id, never a stand-in
 * message id: every Inbox copy of the thread moves, each to its own mailbox's
 * Archive. Team-inbox rows carry no archive target and are skipped by a sweep.
 * Rows hide at once, come back if the call fails, and one "Undo" moves every
 * archived message back.
 */

import { computed, type Ref } from 'vue';
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

	/** Archive the rows `keys` name (those with a target), hiding them while the call runs. */
	async function archiveRows(keys: readonly string[]): Promise<boolean> {
		const targets = keys
			.map((key) => ({ key, target: byKey.value.get(key)?.archive ?? null }))
			.filter((entry): entry is { key: string; target: { threadId: Id<'mailThreads'> } } =>
				Boolean(entry.target)
			);
		if (targets.length === 0) return false;
		for (const { key } of targets) hide(key);
		const moved: { messageId: Id<'mailMessages'>; sourceFolderId: Id<'mailFolders'> }[] = [];
		let isAllLanded = true;
		for (let i = 0; i < targets.length; i += THREADS_PER_CALL) {
			const chunk = targets.slice(i, i + THREADS_PER_CALL);
			const outcome = await archiveOp.run({ threadIds: chunk.map((e) => e.target.threadId) });
			if (outcome.ok) {
				moved.push(...outcome.result.moved);
			} else {
				isAllLanded = false;
				for (const { key } of chunk) unhide(key);
			}
		}
		if (moved.length > 0) {
			triageUndo.registerMoveBack({
				label: t('dashboard.inboxes.archivedUndo', { count: targets.length }, targets.length),
				kind: 'archived',
				moved,
				runMove: (move) => moveOp.run(move),
				after: () => {
					for (const { key } of targets) unhide(key);
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
