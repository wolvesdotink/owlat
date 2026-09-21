/**
 * The shared state behind "Manage folders & labels".
 *
 * The rail gave up its folder and label CRUD on the promise that every one of
 * those verbs still has a home. This is the seam that promise runs through: the
 * More group, a folder row's context menu and a label row's context menu all
 * open ONE dialog, and each of them can aim it at the row (or the create field)
 * the user actually pointed at. The one-shot fields matter as much as the
 * routing — a rename request that survived its dialog would silently re-arm the
 * next time the user opened the manager from somewhere else.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Id } from '@owlat/api/dataModel';
import { usePostboxManageDialog } from '../usePostboxManageDialog';

const folderId = 'folder-1' as Id<'mailFolders'>;
const labelId = 'label-1' as Id<'mailLabels'>;

describe('usePostboxManageDialog', () => {
	beforeEach(() => {
		usePostboxManageDialog().close();
		usePostboxManageDialog().clearFolderDelete();
	});

	it('opens on the folders half by default', () => {
		const dialog = usePostboxManageDialog();
		dialog.openManager();
		expect(dialog.open.value).toBe(true);
		expect(dialog.section.value).toBe('folders');
		expect(dialog.editFolderId.value).toBeNull();
		expect(dialog.focusCreate.value).toBeNull();
	});

	it('infers the section from the row it was aimed at', () => {
		const dialog = usePostboxManageDialog();
		dialog.openManager({ editLabelId: labelId });
		expect(dialog.section.value).toBe('labels');
		expect(dialog.editLabelId.value).toBe(labelId);

		dialog.openManager({ editFolderId: folderId });
		expect(dialog.section.value).toBe('folders');
		expect(dialog.editFolderId.value).toBe(folderId);
		// Aiming somewhere new clears the previous aim.
		expect(dialog.editLabelId.value).toBeNull();
	});

	it('routes a create request to the section it belongs to', () => {
		const dialog = usePostboxManageDialog();
		dialog.openManager({ section: 'labels', create: true });
		expect(dialog.focusCreate.value).toBe('labels');
		dialog.openManager({ section: 'folders', create: true });
		expect(dialog.focusCreate.value).toBe('folders');
	});

	it('clears every one-shot request on close', () => {
		const dialog = usePostboxManageDialog();
		dialog.openManager({ editFolderId: folderId, create: true });
		dialog.close();
		expect(dialog.open.value).toBe(false);
		expect(dialog.editFolderId.value).toBeNull();
		expect(dialog.editLabelId.value).toBeNull();
		expect(dialog.focusCreate.value).toBeNull();
	});

	it('arms one delete confirmation, wherever it was requested from', () => {
		const dialog = usePostboxManageDialog();
		expect(dialog.pendingFolderDelete.value).toBeNull();
		dialog.requestFolderDelete({ _id: folderId, name: 'Receipts' });
		expect(dialog.pendingFolderDelete.value).toEqual({ _id: folderId, name: 'Receipts' });
		// Arming a delete does not need the dialog itself — a rail context menu
		// reaches the same confirmation without opening the manager.
		expect(dialog.open.value).toBe(false);
		dialog.clearFolderDelete();
		expect(dialog.pendingFolderDelete.value).toBeNull();
	});
});
