import type { Id } from '@owlat/api/dataModel';

/**
 * The one "Manage folders & labels" surface, and who is allowed to open it.
 *
 * Folder and label CRUD used to be scattered across the rail: a new-folder
 * button, an inline name input, per-row rename pencils and delete trashcans, a
 * new-label button, a second inline input, and a separate label-manager modal —
 * setup-time verbs occupying permanent chrome in the column you use to navigate.
 * They now live in one dialog, and the rail rows are pure navigation.
 *
 * The dialog keeps several ENTRY points (the rail's "More" group, a right-click
 * on any folder or label row) but exactly one rendering, so this is shared
 * state rather than props threaded through the tree: the label tree is nested
 * three components deep and would otherwise re-emit every intent upward.
 *
 * Module-level refs, the same singleton pattern as `useSidebarState` — the
 * dialog is per-device UI state, never persisted and never per-mailbox.
 */

export type ManageSection = 'folders' | 'labels';

const open = ref(false);
const section = ref<ManageSection>('folders');

/** Row to open in rename mode when the dialog appears (from a context menu). */
const editFolderId = ref<Id<'mailFolders'> | null>(null);
const editLabelId = ref<Id<'mailLabels'> | null>(null);

/** Which create input, if any, should take focus when the dialog appears. */
const focusCreate = ref<ManageSection | null>(null);

/**
 * The folder awaiting delete confirmation. Armed from the manage dialog's trash
 * button AND from a rail row's context menu, and rendered by ONE
 * UiConfirmationDialog in the rail — which is also the component that knows to
 * navigate away when you delete the folder you are reading.
 */
const pendingFolderDelete = ref<{ _id: Id<'mailFolders'>; name: string } | null>(null);

export interface OpenManagerOptions {
	/** Which half of the dialog the caller cares about. Defaults to folders. */
	section?: ManageSection;
	/** Open this folder's name in edit mode. */
	editFolderId?: Id<'mailFolders'>;
	/** Open this label's name in edit mode. */
	editLabelId?: Id<'mailLabels'>;
	/** Put the caret in that section's "new…" field. */
	create?: boolean;
}

export function usePostboxManageDialog() {
	function openManager(options: OpenManagerOptions = {}) {
		const target =
			options.section ?? (options.editLabelId ? 'labels' : options.editFolderId ? 'folders' : null);
		section.value = target ?? 'folders';
		editFolderId.value = options.editFolderId ?? null;
		editLabelId.value = options.editLabelId ?? null;
		focusCreate.value = options.create ? section.value : null;
		open.value = true;
	}

	function close() {
		open.value = false;
		editFolderId.value = null;
		editLabelId.value = null;
		focusCreate.value = null;
	}

	/** Arm the shared delete confirmation for a custom folder. */
	function requestFolderDelete(folder: { _id: Id<'mailFolders'>; name: string }) {
		pendingFolderDelete.value = { _id: folder._id, name: folder.name };
	}

	function clearFolderDelete() {
		pendingFolderDelete.value = null;
	}

	return {
		open,
		section,
		editFolderId,
		editLabelId,
		focusCreate,
		pendingFolderDelete,
		openManager,
		close,
		requestFolderDelete,
		clearFolderDelete,
	};
}
