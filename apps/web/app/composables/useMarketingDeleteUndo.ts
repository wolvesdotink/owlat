/**
 * Delete at once, undo from the toast: the campaign, automation and template
 * lists delete without asking because a delete only moves the item to Recently
 * deleted, where it stays restorable for 30 days.
 *
 * The undo rides the app's one undo stack (`usePostboxTriageUndo`, which the
 * Team Inbox triage shares too): "Deleted Autumn sale · Undo" with the Ctrl+Z /
 * ⌘Z hint on the newest entry. One stack means one Ctrl+Z binding, so a key
 * press can never restore a campaign and un-archive a message at once, and the
 * key stays with a focused text field, which keeps its own undo. The stack
 * takes an entry before its inverse runs, so the button and the key restore an
 * item once. A failed restore reports itself through the restore operation's
 * own error toast, and the item stays in Recently deleted.
 */

import { usePostboxTriageUndo } from '~/composables/postbox/usePostboxTriageUndo';

export interface UndoableDelete {
	/** The item's name, as the toast says it: "Deleted Autumn sale". */
	name: string;
	/** The delete; resolves whether it happened. */
	remove: () => Promise<boolean>;
	/** The inverse, run by Undo or the keyboard. */
	restore: () => Promise<unknown>;
}

export function useMarketingDeleteUndo() {
	const { t } = useI18n();
	const undoStack = usePostboxTriageUndo();

	/** Delete, and on success offer the undo. Resolves whether the delete happened. */
	async function deleteWithUndo(item: UndoableDelete): Promise<boolean> {
		if (!(await item.remove())) return false;
		undoStack.register({
			label: t('shared.marketingDeleteUndo.deleted', { name: item.name }),
			inverse: async () => {
				await item.restore();
			},
		});
		return true;
	}

	return { deleteWithUndo };
}
