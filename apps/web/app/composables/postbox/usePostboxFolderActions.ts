/**
 * Create / rename / delete / unsubscribe custom mail folders.
 *
 * Wraps the api.mail.folders.* mutations through useBackendOperation so each
 * carries the standard error/toast treatment. System folders (those with a
 * role) reject rename/remove on the backend.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export function usePostboxFolderActions(mailboxId: Ref<Id<'mailboxes'> | null>) {
	const { run: createMutation } = useBackendOperation(api.mail.folders.create, {
		label: 'Create folder',
	});
	const { run: renameMutation } = useBackendOperation(api.mail.folders.rename, {
		label: 'Rename folder',
	});
	const { run: removeMutation } = useBackendOperation(api.mail.folders.remove, {
		label: 'Delete folder',
	});
	const { run: subscribeMutation } = useBackendOperation(api.mail.folders.setSubscribed, {
		label: 'Update folder',
	});

	async function create(name: string): Promise<boolean> {
		if (!mailboxId.value || !name.trim()) return false;
		const result = await createMutation({ mailboxId: mailboxId.value, name: name.trim() });
		return result !== undefined;
	}

	async function rename(folderId: Id<'mailFolders'>, name: string): Promise<boolean> {
		if (!name.trim()) return false;
		const result = await renameMutation({ folderId, name: name.trim() });
		return result !== undefined;
	}

	async function remove(folderId: Id<'mailFolders'>): Promise<boolean> {
		const result = await removeMutation({ folderId });
		return result !== undefined;
	}

	async function unsubscribe(folderId: Id<'mailFolders'>): Promise<boolean> {
		const result = await subscribeMutation({ folderId, subscribed: false });
		return result !== undefined;
	}

	return { create, rename, remove, unsubscribe };
}
