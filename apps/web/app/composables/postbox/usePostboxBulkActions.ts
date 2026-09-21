/**
 * Bulk-selection state + triage actions for the thread/message list.
 *
 * Selection lives in a per-mailbox useState bucket so navigating between
 * folders doesn't carry stale picks across. Alongside it sit the two pieces
 * that make a large selection cheap to build: the ANCHOR that Shift+click and
 * Shift+J/K extend a range from (utils/postboxRangeSelect.ts), and the
 * "select all matching" flag for a selection that came from the server-side id
 * query rather than the rows on screen.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { rangeBetween } from '~/utils/postboxRangeSelect';

/** Provenance of the current selection, for the header's count line. */
interface SelectAllMatchingState {
	/** True while the selection is the server's whole-folder answer. */
	active: boolean;
	/** True when that answer hit the server's cap and is a prefix, not the lot. */
	capped: boolean;
}

export function usePostboxBulkActions(mailboxId: Ref<Id<'mailboxes'> | null>) {
	const { t } = useI18n();
	const stateKey = computed(() => `postbox:bulk:${mailboxId.value ?? 'no-mailbox'}`);

	const selected = useState<Set<Id<'mailMessages'>>>(stateKey.value, () => new Set());
	// The anchor is a message ID, not an index: rows shift under the selection
	// as mail arrives, and an index would silently re-anchor to a neighbour.
	const anchorId = useState<Id<'mailMessages'> | null>(`${stateKey.value}:anchor`, () => null);
	const selectAllMatching = useState<SelectAllMatchingState>(
		`${stateKey.value}:all-matching`,
		() => ({ active: false, capped: false })
	);

	/** Any change that isn't the whole-folder answer stops claiming to be one. */
	function dropAllMatchingClaim() {
		if (selectAllMatching.value.active) {
			selectAllMatching.value = { active: false, capped: false };
		}
	}

	function isSelected(id: Id<'mailMessages'>) {
		return selected.value.has(id);
	}

	function toggle(id: Id<'mailMessages'>) {
		const next = new Set(selected.value);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selected.value = next;
		// A plain toggle is where the next range starts from, selecting or not:
		// Shift+click after unchecking a row still extends from that row.
		anchorId.value = id;
		dropAllMatchingClaim();
	}

	function selectMany(ids: Id<'mailMessages'>[]) {
		if (ids.length === 0) return;
		const next = new Set(selected.value);
		for (const id of ids) next.add(id);
		selected.value = next;
		dropAllMatchingClaim();
	}

	/**
	 * Shift+click / Shift+J/K: add every row between the anchor and `targetId`
	 * in the order the list renders. Without a live anchor this degrades to
	 * selecting the target alone (and anchoring there), never to a range that
	 * spans the whole list.
	 */
	function extendTo(
		orderedIds: Id<'mailMessages'>[],
		targetId: Id<'mailMessages'>,
		/** Where to anchor when there is no anchor yet (the row Shift+J left). */
		fallbackAnchorId?: Id<'mailMessages'>
	) {
		const anchor = anchorId.value ?? fallbackAnchorId ?? null;
		const range = rangeBetween(orderedIds, anchor, targetId) as Id<'mailMessages'>[];
		if (range.length === 0) return;
		selectMany(range);
		// The anchor STAYS put: growing and shrinking a range with further
		// Shift presses only works while it keeps pointing at where it began.
		anchorId.value = anchor ?? targetId;
	}

	/** Replace the selection with the whole page of rows the list is showing. */
	function selectPage(pageIds: Id<'mailMessages'>[]) {
		selectMany(pageIds);
		anchorId.value = pageIds[0] ?? null;
	}

	/**
	 * Adopt the server's whole-folder id answer. `capped` says the answer is
	 * the first N rather than every match, so the UI can say so instead of
	 * promising a selection it doesn't hold.
	 */
	function selectAllMatchingIds(matchingIds: Id<'mailMessages'>[], capped: boolean) {
		selected.value = new Set(matchingIds);
		anchorId.value = matchingIds[0] ?? null;
		selectAllMatching.value = { active: matchingIds.length > 0, capped };
	}

	function clear() {
		selected.value = new Set();
		anchorId.value = null;
		selectAllMatching.value = { active: false, capped: false };
	}

	const count = computed(() => selected.value.size);
	const ids = computed(() => Array.from(selected.value));

	// Successful triage actions register their inverse for the "Undo" toast
	// (move each message back to its source folder; spam is un-verdicted too).
	const triageUndo = usePostboxTriageUndo();
	type UndoAction = 'archived' | 'trashed' | 'moved' | 'spam';
	const undoLabel = (action: UndoAction, n: number) =>
		n > 1
			? t(`shared.postbox.usePostboxBulkActions.undo.${action}Many`, { count: n })
			: t(`shared.postbox.usePostboxBulkActions.undo.${action}`);

	const setFlags = useBackendOperation(api.mail.messageActions.setFlags, {
		label: () => t('shared.postbox.usePostboxBulkActions.setFlagsOperation'),
	});
	const archive = useBackendOperation(api.mail.messageActions.archive, {
		label: () => t('shared.postbox.usePostboxBulkActions.archiveOperation'),
	});
	const trash = useBackendOperation(api.mail.messageActions.trash, {
		label: () => t('shared.postbox.usePostboxBulkActions.trashOperation'),
	});
	const purge = useBackendOperation(api.mail.messageActions.purge, {
		label: () => t('shared.postbox.usePostboxBulkActions.purgeOperation'),
	});
	const move = useBackendOperation(api.mail.messageActions.move, {
		label: () => t('shared.postbox.usePostboxBulkActions.moveOperation'),
	});
	const reportSpamOp = useBackendOperation(api.mail.messageActions.reportSpam, {
		label: () => t('shared.postbox.usePostboxBulkActions.reportSpamOperation'),
	});
	const notSpamOp = useBackendOperation(api.mail.messageActions.notSpam, {
		label: () => t('shared.postbox.usePostboxBulkActions.notSpamOperation'),
	});

	async function markRead(seen: boolean) {
		if (ids.value.length === 0) return;
		await setFlags.run({ messageIds: ids.value, seen });
	}

	async function star(starred: boolean) {
		if (ids.value.length === 0) return;
		await setFlags.run({ messageIds: ids.value, flagged: starred });
	}

	async function archiveSelected() {
		if (ids.value.length === 0) return;
		const result = await archive.run({ messageIds: ids.value });
		if (!result.ok) return;
		if (result.result?.moved) {
			triageUndo.registerMoveBack({
				label: undoLabel('archived', result.result.moved.length),
				moved: result.result.moved,
				runMove: (a) => move.run(a),
			});
		}
		clear();
	}

	async function trashSelected() {
		if (ids.value.length === 0) return;
		const result = await trash.run({ messageIds: ids.value });
		if (!result.ok) return;
		if (result.result?.moved) {
			triageUndo.registerMoveBack({
				label: undoLabel('trashed', result.result.moved.length),
				moved: result.result.moved,
				runMove: (a) => move.run(a),
			});
		}
		clear();
	}

	async function purgeSelected() {
		if (ids.value.length === 0) return;
		const result = await purge.run({ messageIds: ids.value });
		if (!result.ok) return;
		clear();
	}

	async function moveSelected(targetFolderId: Id<'mailFolders'>) {
		if (ids.value.length === 0) return;
		const result = await move.run({ messageIds: ids.value, targetFolderId });
		if (!result.ok) return;
		if (result.result.moved) {
			triageUndo.registerMoveBack({
				label: undoLabel('moved', result.result.moved.length),
				moved: result.result.moved,
				runMove: (a) => move.run(a),
			});
		}
		clear();
	}

	async function reportSpamSelected() {
		if (ids.value.length === 0) return;
		const messageIds = ids.value;
		const result = await reportSpamOp.run({ messageIds });
		if (!result.ok) return;
		if (result.result.moved) {
			// notSpam clears the verdict (and parks in Inbox); the follow-up
			// move restores the true source folder when it wasn't the Inbox.
			triageUndo.registerMoveBack({
				label: undoLabel('spam', result.result.moved.length),
				moved: result.result.moved,
				before: () => notSpamOp.run({ messageIds }),
				runMove: (a) => move.run(a),
			});
		}
		clear();
	}

	async function notSpamSelected() {
		if (ids.value.length === 0) return;
		const result = await notSpamOp.run({ messageIds: ids.value });
		if (!result.ok) return;
		clear();
	}

	return {
		selected,
		anchorId,
		selectAllMatching,
		ids,
		count,
		isSelected,
		toggle,
		extendTo,
		selectPage,
		selectAllMatchingIds,
		selectMany,
		clear,
		markRead,
		star,
		archiveSelected,
		trashSelected,
		purgeSelected,
		moveSelected,
		reportSpamSelected,
		notSpamSelected,
	};
}
