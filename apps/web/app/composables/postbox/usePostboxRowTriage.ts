/**
 * The Postbox list's triage verbs — archive, trash, star, read, snooze (message
 * or whole thread), mute, move, cancel-follow-up — as ONE action source.
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
import type { PostboxFlagOverride } from './usePostboxOptimisticFlags';
import {
	optimisticArchive,
	optimisticMarkRead,
	optimisticMove,
	optimisticSetStar,
	optimisticSnooze,
	optimisticSnoozeThread,
	optimisticTrash,
} from '~/lib/mailOptimistic/mailUpdaters';

export function usePostboxRowTriage(args: {
	/** Hide a row optimistically while its mutation is in flight. */
	hide: (id: Id<'mailMessages'>) => void;
	/** Restore a row whose mutation failed, or that the user undid. */
	unhide: (id: Id<'mailMessages'>) => void;
	/** Paint a star / read change on a row while its mutation is in flight. */
	setFlags: (id: Id<'mailMessages'>, patch: PostboxFlagOverride) => void;
	/** Drop a row's painted flags — the mutation failed, the server value wins. */
	clearFlags: (id: Id<'mailMessages'>) => void;
}) {
	const { t } = useI18n();
	const triageUndo = usePostboxTriageUndo();

	// Each verb also carries its native optimistic update (plan 2.2), which
	// patches every other surface the row appears on (the rail's counts, the
	// open conversation, the sidebar). The list's own hide/flag claims below
	// set the same absolute values, so the two agree rather than stack.
	const archiveOp = useBackendOperation(api.mail.messageActions.archive, {
		label: () => t('components.postbox.postboxThreadList.archiveOperation'),
		optimisticUpdate: optimisticArchive,
	});
	const trashOp = useBackendOperation(api.mail.messageActions.trash, {
		label: () => t('components.postbox.postboxThreadList.trashOperation'),
		optimisticUpdate: optimisticTrash,
	});
	const setStarOp = useBackendOperation(api.mail.messageActions.setStar, {
		label: () => t('components.postbox.postboxThreadList.starOperation'),
		optimisticUpdate: optimisticSetStar,
	});
	const markReadOp = useBackendOperation(api.mail.messageActions.markRead, {
		label: () => t('components.postbox.postboxThreadList.markReadOperation'),
		optimisticUpdate: optimisticMarkRead,
	});
	const snoozeOp = useBackendOperation(api.mail.snooze.snooze, {
		label: () => t('components.postbox.postboxThreadList.snoozeOperation'),
		optimisticUpdate: optimisticSnooze,
	});
	const snoozeThreadOp = useBackendOperation(api.mail.snooze.snoozeThread, {
		label: () => t('components.postbox.postboxThreadList.snoozeOperation'),
		optimisticUpdate: optimisticSnoozeThread,
	});
	const setMutedOp = useBackendOperation(api.mail.mute.setMutedForMessage, {
		label: () => t('components.postbox.postboxThreadList.muteOperation'),
	});
	const moveOp = useBackendOperation(api.mail.messageActions.move, {
		label: () => t('components.postbox.postboxThreadList.moveOperation'),
		optimisticUpdate: optimisticMove,
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
	 * Resolves to whether the mutation landed.
	 */
	async function runRemoving(
		ids: Id<'mailMessages'>[],
		undoLabel: string,
		mutate: () => Promise<
			BackendOperationResult<{
				moved: Parameters<typeof triageUndo.registerMoveBack>[0]['moved'];
			} | null>
		>
	) {
		const unhideAll = () => {
			for (const id of ids) args.unhide(id);
		};
		for (const id of ids) args.hide(id);
		const outcome = await mutate();
		if (!outcome.ok || outcome.result === null) {
			unhideAll();
			return false;
		}
		if (outcome.result.moved.length > 0) {
			triageUndo.registerMoveBack({
				label: undoLabel,
				moved: outcome.result.moved,
				runMove: (a) => moveOp.run(a),
				after: unhideAll,
			});
		}
		return true;
	}

	const archiveMsg = (id: Id<'mailMessages'>) =>
		runRemoving([id], t('components.postbox.postboxThreadList.archivedUndo'), () =>
			archiveOp.run({ messageIds: [id] })
		);

	const trashMsg = (id: Id<'mailMessages'>) =>
		runRemoving([id], t('components.postbox.postboxThreadList.trashedUndo'), () =>
			trashOp.run({ messageIds: [id] })
		);

	/**
	 * Move one row or several (a dragged selection) in ONE mutation, so the undo
	 * toast is one entry that puts every one of them back.
	 */
	const moveMany = (ids: Id<'mailMessages'>[], targetFolderId: Id<'mailFolders'>) =>
		ids.length === 0
			? Promise.resolve(false)
			: runRemoving(
					ids,
					ids.length > 1
						? t('shared.postbox.usePostboxBulkActions.undo.movedMany', { count: ids.length })
						: t('components.postbox.postboxThreadList.movedUndo'),
					() => moveOp.run({ messageIds: ids, targetFolderId })
				);

	const moveMsg = (id: Id<'mailMessages'>, targetFolderId: Id<'mailFolders'>) =>
		moveMany([id], targetFolderId);

	/**
	 * Star and mark-read keep their row, so instead of the hide/restore pair they
	 * paint the new flag immediately and drop the claim if the mutation fails —
	 * the list's `usePostboxOptimisticFlags` prunes it once the subscription
	 * delivers the confirmed row.
	 */
	async function toggleStar(id: Id<'mailMessages'>, starred: boolean) {
		args.setFlags(id, { flagFlagged: starred });
		if (!(await setStarOp.run({ messageId: id, starred })).ok) args.clearFlags(id);
	}

	async function toggleRead(id: Id<'mailMessages'>, seen: boolean) {
		args.setFlags(id, { flagSeen: seen });
		if (!(await markReadOp.run({ messageId: id, seen })).ok) args.clearFlags(id);
	}

	/** Snooze is row-removing but has no `moved` inverse — it un-hides on failure. */
	async function snoozeMsg(id: Id<'mailMessages'>, until: number) {
		args.hide(id);
		if (!(await snoozeOp.run({ messageId: id, until })).ok) args.unhide(id);
	}

	/**
	 * Thread-scope snooze (the dialog's default): defers the whole conversation
	 * server-side. Only the focused row is hidden optimistically — the siblings
	 * are on other pages or not rendered, and the subscription drops them a beat
	 * later anyway.
	 */
	async function snoozeThread(id: Id<'mailMessages'>, threadId: string, until: number) {
		args.hide(id);
		const outcome = await snoozeThreadOp.run({ threadId: threadId as Id<'mailThreads'>, until });
		if (!outcome.ok) args.unhide(id);
	}

	/**
	 * Mute/unmute the row's conversation. Muting archives the thread's inbox mail
	 * server-side, so the row is hidden optimistically; unmuting changes nothing
	 * about where the mail sits and leaves the row alone.
	 */
	async function toggleMute(id: Id<'mailMessages'>, muted: boolean) {
		if (muted) args.hide(id);
		const outcome = await setMutedOp.run({ messageId: id, muted });
		if (muted && !outcome.ok) args.unhide(id);
	}

	function cancelFollowUp(msg: { threadId?: string }) {
		if (!msg.threadId) return;
		void cancelFollowUpOp.run({ threadId: msg.threadId as Id<'mailThreads'> });
	}

	return {
		archiveMsg,
		trashMsg,
		moveMsg,
		moveMany,
		snoozeMsg,
		snoozeThread,
		toggleMute,
		toggleStar,
		toggleRead,
		cancelFollowUp,
	};
}
