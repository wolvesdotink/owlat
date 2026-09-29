/**
 * Drag-and-drop of thread-list rows onto the folder rail — the pure half.
 *
 * Dragging is a fourth entry point to verbs the list already has (the `v` move
 * picker, the bulk bar's Move, the `l` label picker), so the rules for WHAT a
 * drag carries and WHERE it may land mirror theirs rather than inventing new
 * ones. The session state and the DOM wiring live in
 * `composables/postbox/usePostboxMessageDrag.ts`.
 */

/**
 * The dataTransfer type a Postbox row drag carries. A private MIME type so a
 * file drop, a text drag or a link from another tab can never be mistaken for
 * a message drag by a folder row.
 */
export const POSTBOX_MESSAGE_DRAG_TYPE = 'application/x-owlat-messages';

/**
 * The messages a drag started on `rowId` moves. Grabbing a row that is part of
 * the bulk selection drags the whole selection, in selection order (the file
 * manager idiom); grabbing any other row drags that row alone and leaves the
 * selection as it was.
 */
export function dragMessageIds<Id extends string>(rowId: Id, selected: readonly Id[]): Id[] {
	return selected.includes(rowId) ? [...selected] : [rowId];
}

/** Folder roles a message is never moved into by hand. */
const NON_DESTINATION_ROLES = new Set(['sent', 'drafts']);

/**
 * Whether a folder row accepts the current drag. The same destination rule as
 * the move pickers: Sent and Drafts are never targets (a received message filed
 * there is mis-framed as your own), the folder the rows came from is a no-op,
 * and a drag never crosses into another mailbox's rail.
 *
 * `sourceFolder` is the list's route segment — a system role (`inbox`) or a
 * custom folder's id — or null when the list is not one folder (a label view,
 * search results), in which case every folder is fair game.
 */
export function acceptsMessageDrop(
	folder: { _id: string; role?: string | null },
	drag: { mailboxId: string; sourceFolder: string | null },
	targetMailboxId: string
): boolean {
	if (drag.mailboxId !== targetMailboxId) return false;
	if (folder.role && NON_DESTINATION_ROLES.has(folder.role)) return false;
	if (drag.sourceFolder !== null) {
		if (folder._id === drag.sourceFolder) return false;
		if (folder.role && folder.role === drag.sourceFolder) return false;
	}
	return true;
}
