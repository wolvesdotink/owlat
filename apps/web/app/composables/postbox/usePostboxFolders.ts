/**
 * Folder list with reactive unread counts.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'archive';

export function usePostboxFolders(mailboxId: Ref<Id<'mailboxes'> | null>) {
	const { data, isLoading } = useConvexQuery(
		api.mail.mailbox.listFolders,
		() => (mailboxId.value ? { mailboxId: mailboxId.value } : 'skip')
	);

	const folders = computed(() => data.value ?? []);

	const folderBySlug = (slug: string) => {
		return folders.value.find((f) => f.role === slug);
	};

	const systemFolders = computed(() =>
		folders.value
			.filter((f) => !!f.role)
			.sort((a, b) => {
				const order: Record<string, number> = {
					inbox: 0,
					drafts: 1,
					sent: 2,
					archive: 3,
					spam: 4,
					trash: 5,
				};
				return (order[a.role ?? ''] ?? 99) - (order[b.role ?? ''] ?? 99);
			})
	);

	const unreadByRole = computed(() => {
		const map: Record<string, number> = {};
		for (const folder of folders.value) {
			if (folder.role) map[folder.role] = folder.unseenCount;
		}
		return map;
	});

	// Subscribed custom (non-role) folders — e.g. user-created or custom IMAP
	// folders that don't map to a system role. Navigated by id, not role.
	const customFolders = computed(() =>
		folders.value
			.filter((f) => !f.role && f.subscribed)
			.sort((a, b) => a.name.localeCompare(b.name))
	);

	return {
		folders,
		systemFolders,
		customFolders,
		unreadByRole,
		folderBySlug,
		isLoading,
	};
}
