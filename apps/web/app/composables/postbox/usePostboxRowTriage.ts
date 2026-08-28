/**
 * The Postbox list's triage verbs — archive, trash, star, read, snooze, move,
 * cancel-follow-up — as ONE action source.
 *
 * PostboxThreadList owns the v-for, windowing and keyboard handling; every
 * entry point it exposes (hover buttons, right-click menu, long-press menu,
 * single-key shortcuts) routes a verb through here, so the optimistic hide,
 * the failure restore and the Cmd+Z undo registration are written once instead
 * of once per entry point.
 *
 * Optimistic hiding is injected rather than owned: the list derives its visible
 * rows from `usePostboxOptimisticHide` over its own props, so this composable
 * takes `hide`/`unhide` callbacks and stays free of the list's row state.
 *
 * Extracted from PostboxThreadList.vue, which the file-size ratchet caps at
 * ~500 LOC (see scripts/check-file-size.sh).
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export function usePostboxRowTriage(args: {
	/** Hide a row optimistically while its mutation is in flight. */
	hide: (id: Id<'mailMessages'>) => void;
	/** Restore a row whose mutation failed, or that the user undid. */
	unhide: (id: Id<'mailMessages'>) => void;
}) {
	const { t } = useI18n();
	const triageUndo = usePostboxTriageUndo();

	const archiveOp = useBackendOperation(api.mail.messageActions.archive, {
		label: () => t('components.postbox.postboxThreadList.archiveOperation'),
	});
	const trashOp = useBackendOperation(api.mail.messageActions.trash, {
		label: () => t('components.postbox.postboxThreadList.trashOperation'),
	});
	const setStarOp = useBackendOperation(api.mail.messageActions.setStar, {
		label: () => t('components.postbox.postboxThreadList.starOperation'),
	});
	const markReadOp = useBackendOperation(api.mail.messageActions.markRead, {
		label: () => t('components.postbox.postboxThreadList.markReadOperation'),
	});
	const snoozeOp = useBackendOperation(api.mail.snooze.snooze, {
		label: () => t('components.postbox.postboxThreadList.snoozeOperation'),
	});
	const moveOp = useBackendOperation(api.mail.messageActions.move, {
		label: () => t('components.postbox.postboxThreadList.moveOperation'),
	});
	// Follow-up chip on a watched row: cancel the armed watch / dismiss the due
	// "No reply yet" indicator. Ownership-checked server-side.
	const cancelFollowUpOp = useBackendOperation(api.mail.followUps.cancel, {
		label: () => t('components.postbox.postboxThreadList.cancelFollowUpOperation'),
	});

	/**
	 * Run a row-removing mutation: hide first, restore on failure, and register
	 * the inverse move for the "Undo — Cmd+Z" toast when rows actually moved.
	 * archive/trash/move all return `{ ok, moved }`, so they share this shape.
	 */
	async function runRemoving(
		id: Id<'mailMessages'>,
		undoLabel: string,
		mutate: () => Promise<
			BackendOperationResult<{
				moved: Parameters<typeof triageUndo.registerMoveBack>[0]['moved'];
			} | null>
		>
	) {
		args.hide(id);
		const outcome = await mutate();
		if (!outcome.ok || outcome.result === null) {
			args.unhide(id);
			return;
		}
		if (outcome.result.moved.length > 0) {
			triageUndo.registerMoveBack({
				label: undoLabel,
				moved: outcome.result.moved,
				runMove: (a) => moveOp.run(a),
				after: () => args.unhide(id),
			});
		}
	}

	const archiveMsg = (id: Id<'mailMessages'>) =>
		runRemoving(id, t('components.postbox.postboxThreadList.archivedUndo'), () =>
			archiveOp.run({ messageIds: [id] })
		);

	const trashMsg = (id: Id<'mailMessages'>) =>
		runRemoving(id, t('components.postbox.postboxThreadList.trashedUndo'), () =>
			trashOp.run({ messageIds: [id] })
		);

	const moveMsg = (id: Id<'mailMessages'>, targetFolderId: Id<'mailFolders'>) =>
		runRemoving(id, t('components.postbox.postboxThreadList.movedUndo'), () =>
			moveOp.run({ messageIds: [id], targetFolderId })
		);

	function toggleStar(id: Id<'mailMessages'>, starred: boolean) {
		void setStarOp.run({ messageId: id, starred });
	}

	function toggleRead(id: Id<'mailMessages'>, seen: boolean) {
		void markReadOp.run({ messageId: id, seen });
	}

	/** Snooze is row-removing but has no `moved` inverse — it un-hides on failure. */
	async function snoozeMsg(id: Id<'mailMessages'>, until: number) {
		args.hide(id);
		if (!(await snoozeOp.run({ messageId: id, until })).ok) args.unhide(id);
	}

	function cancelFollowUp(msg: { threadId?: string }) {
		if (!msg.threadId) return;
		void cancelFollowUpOp.run({ threadId: msg.threadId as Id<'mailThreads'> });
	}

	return { archiveMsg, trashMsg, moveMsg, snoozeMsg, toggleStar, toggleRead, cancelFollowUp };
}
