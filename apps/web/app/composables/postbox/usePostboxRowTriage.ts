/**
 * The Postbox list's triage verbs — archive, trash, star, read, snooze (message
 * or whole thread), mute, pin, move, cancel-follow-up — as ONE action source.
 *
 * PostboxThreadList owns the v-for, windowing and keyboard handling; every
 * entry point it exposes (hover buttons, right-click menu, long-press menu,
 * single-key shortcuts, swipes, sweeps) routes a verb through here, so the optimistic hide,
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
import { chunkForMove, type PostboxMoveUndoKind } from './usePostboxTriageUndo';
import type { PostboxSwipeAction } from '~/utils/postboxSwipe';
import {
	optimisticArchive,
	optimisticMarkRead,
	optimisticMove,
	optimisticSetStar,
	optimisticSnooze,
	optimisticSnoozeThread,
	optimisticTrash,
} from '~/lib/mailOptimistic/mailUpdaters';
import { usePostboxPinAction } from './usePostboxPins';
import { leaveDeletedOpenRow } from './usePostboxDeletedOpenRow';

export function usePostboxRowTriage(args: {
	/** Hide a row optimistically while its mutation is in flight. */
	hide: (id: Id<'mailMessages'>) => void;
	/** Restore a row whose mutation failed, or that the user undid. */
	unhide: (id: Id<'mailMessages'>) => void;
	/** Paint a star / read change on a row while its mutation is in flight. */
	setFlags: (id: Id<'mailMessages'>, patch: PostboxFlagOverride) => void;
	/** Drop a row's painted flags — the mutation failed, the server value wins. */
	clearFlags: (id: Id<'mailMessages'>) => void;
	/** True for the mailbox's Trash folder: a move there is a delete. */
	isTrashFolder?: (folderId: Id<'mailFolders'>) => boolean;
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
	const pinAction = usePostboxPinAction();
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
	 *
	 * A long range (a sweep, a dragged selection) goes in calls of at most
	 * `POSTBOX_MESSAGES_PER_MOVE` messages, one after another, so no call
	 * outgrows a transaction. The first failed call stops the run, so one error
	 * is shown rather than one per call: its rows and the ones not yet sent come
	 * back, and what the earlier calls moved stays moved under ONE Undo entry.
	 * Resolves to whether every call landed.
	 *
	 * A delete (`isDelete`) also takes the reader off the open conversation when
	 * it is among `ids`, and brings it back if that row's call fails.
	 */
	async function runRemoving(
		ids: Id<'mailMessages'>[],
		undoLabel: (count: number) => string,
		undoKind: { kind: PostboxMoveUndoKind; scope?: string },
		mutate: (chunk: Id<'mailMessages'>[]) => Promise<
			BackendOperationResult<{
				moved: Parameters<typeof triageUndo.registerMoveBack>[0]['moved'];
			} | null>
		>,
		isDelete = false
	) {
		// Before the hide: the reader's next row comes from the order on screen.
		const returnToOpenRow = isDelete ? leaveDeletedOpenRow(ids) : null;
		for (const id of ids) args.hide(id);
		const landed: Id<'mailMessages'>[] = [];
		const moved: Parameters<typeof triageUndo.registerMoveBack>[0]['moved'] = [];
		let isAllLanded = true;
		// A `null` answer is the server's "row already gone" soft-fail: the
		// reader has nothing to go back to for that call's rows.
		let alreadyGone = 0;
		for (const chunk of chunkForMove(ids)) {
			const outcome = await mutate(chunk);
			if (!outcome.ok || outcome.result == null) {
				isAllLanded = false;
				if (outcome.ok) alreadyGone = chunk.length;
				break;
			}
			landed.push(...chunk);
			moved.push(...outcome.result.moved);
		}
		const failed = ids.slice(landed.length);
		for (const id of failed) args.unhide(id);
		const notDeleted = failed.slice(alreadyGone);
		if (notDeleted.length > 0) returnToOpenRow?.(notDeleted);
		if (moved.length > 0) {
			triageUndo.registerMoveBack({
				label: undoLabel(landed.length),
				...undoKind,
				moved,
				runMove: (a) => moveOp.run(a),
				after: () => {
					for (const id of landed) args.unhide(id);
				},
			});
		}
		return isAllLanded;
	}

	/**
	 * Archive one row or several (a sweep across the Archive buttons) under ONE
	 * undo entry that puts every one of them back. The ids must share a
	 * mailbox: the server files each call's messages in its first one's
	 * Archive folder.
	 */
	const archiveMany = (ids: Id<'mailMessages'>[]) =>
		ids.length === 0
			? Promise.resolve(false)
			: runRemoving(
					ids,
					(count) =>
						count > 1
							? t('shared.postbox.usePostboxBulkActions.undo.archivedMany', { count })
							: t('components.postbox.postboxThreadList.archivedUndo'),
					{ kind: 'archived' },
					(chunk) => archiveOp.run({ messageIds: chunk })
				);

	const archiveMsg = (id: Id<'mailMessages'>) => archiveMany([id]);

	const trashMsg = (id: Id<'mailMessages'>) =>
		runRemoving(
			[id],
			() => t('components.postbox.postboxThreadList.trashedUndo'),
			{ kind: 'trashed' },
			(chunk) => trashOp.run({ messageIds: chunk }),
			true
		);

	/**
	 * Move one row or several (a dragged selection) under ONE undo entry that
	 * puts every one of them back.
	 */
	const moveMany = (ids: Id<'mailMessages'>[], targetFolderId: Id<'mailFolders'>) =>
		ids.length === 0
			? Promise.resolve(false)
			: runRemoving(
					ids,
					(count) =>
						count > 1
							? t('shared.postbox.usePostboxBulkActions.undo.movedMany', { count })
							: t('components.postbox.postboxThreadList.movedUndo'),
					{ kind: 'moved', scope: targetFolderId },
					(chunk) => moveOp.run({ messageIds: chunk, targetFolderId }),
					args.isTrashFolder?.(targetFolderId) === true
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

	/** Mute/unmute a row's conversation (the `m` shortcut + context menu). */
	function toggleMuteRow(m: { _id: Id<'mailMessages'>; mutedAt?: number }) {
		void toggleMute(m._id, m.mutedAt == null);
	}

	/**
	 * Pin/unpin a row's conversation. A pin moves no mail, so the row stays
	 * where it is and the band picks the thread up from its own query.
	 */
	function togglePinRow(m: { _id: Id<'mailMessages'>; pinnedAt?: number }) {
		void pinAction.toggle(m._id, m.pinnedAt != null);
	}

	/**
	 * A committed swipe on a row. It is a fourth ENTRY POINT, not a fourth
	 * implementation: every branch lands on the verb the hover buttons, the
	 * context menu and the single-key shortcuts already call, so the optimistic
	 * hide and the "Undo — Cmd+Z" registration come along for free. Snooze opens
	 * the same picker `h` does — a deferral needs a time, and guessing one from a
	 * gesture is how mail disappears until Thursday.
	 */
	function swipeRow(
		m: { _id: Id<'mailMessages'>; threadId?: string; flagFlagged: boolean; flagSeen: boolean },
		action: Exclude<PostboxSwipeAction, 'none'>,
		openSnooze: (id: Id<'mailMessages'>, threadId: string | null) => void
	) {
		switch (action) {
			case 'archive':
				void archiveMsg(m._id);
				break;
			case 'trash':
				void trashMsg(m._id);
				break;
			case 'star':
				void toggleStar(m._id, !m.flagFlagged);
				break;
			case 'read':
				void toggleRead(m._id, !m.flagSeen);
				break;
			case 'snooze':
				openSnooze(m._id, m.threadId ?? null);
				break;
		}
	}

	function cancelFollowUp(msg: { threadId?: string }) {
		if (!msg.threadId) return;
		void cancelFollowUpOp.run({ threadId: msg.threadId as Id<'mailThreads'> });
	}

	return {
		archiveMsg,
		archiveMany,
		trashMsg,
		moveMsg,
		moveMany,
		snoozeMsg,
		snoozeThread,
		toggleMute,
		toggleMuteRow,
		togglePinRow,
		toggleStar,
		toggleRead,
		cancelFollowUp,
		swipeRow,
	};
}
