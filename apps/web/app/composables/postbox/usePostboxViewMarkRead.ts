/**
 * "Mark … as read" for the parts of a folder's grouped views: a Categories
 * section (every unread message of that category in the folder, loaded or
 * not) and a bundle (the unread messages the bundle row holds). The palette
 * offers the same for each Categories section that shows unread mail.
 */
import type { Id } from '@owlat/api/dataModel';
import type { MailCategory } from '~/utils/mailCategory';
import { findViewFolder } from './usePostboxFolderBulk';
import type { PostboxMarkReadCommand } from './usePostboxCommandSurface';

export function usePostboxViewMarkRead(args: {
	mailboxId: Ref<Id<'mailboxes'> | null>;
	folderRole: Ref<string>;
	folderId: Ref<Id<'mailFolders'> | undefined>;
	/** True while the Categories view is the renderer on screen. */
	categoriesOnScreen: Ref<boolean>;
	/** The Categories view's sections; `label` is a message key. */
	categorySections: Ref<
		ReadonlyArray<{
			key: MailCategory;
			label: string;
			threads: ReadonlyArray<{ unreadCount: number }>;
		}>
	>;
}) {
	const { t } = useI18n();
	const { folders } = usePostboxFolders(args.mailboxId);
	const folderBulk = usePostboxFolderBulk(args.mailboxId);
	const folder = computed(() =>
		findViewFolder(folders.value, args.folderRole.value, args.folderId.value)
	);

	function markCategoryRead(category: MailCategory) {
		if (!folder.value) return;
		void folderBulk.markRead({
			kind: 'category',
			folderId: folder.value._id as Id<'mailFolders'>,
			category,
		});
	}

	function markBundleRead(messageIds: readonly string[]) {
		void folderBulk.markRead({
			kind: 'messages',
			messageIds: messageIds as Id<'mailMessages'>[],
		});
	}

	function commands(): PostboxMarkReadCommand[] {
		const current = folder.value;
		if (!args.categoriesOnScreen.value || !current) return [];
		return args.categorySections.value
			.filter((section) => section.threads.some((thread) => thread.unreadCount > 0))
			.map((section) => ({
				key: `category:${section.key}`,
				label: t('components.postbox.postboxFolderActions.markCategoryRead', {
					category: t(section.label),
				}),
				target: {
					kind: 'category' as const,
					folderId: current._id as Id<'mailFolders'>,
					category: section.key,
				},
			}));
	}

	return { markCategoryRead, markBundleRead, commands };
}
