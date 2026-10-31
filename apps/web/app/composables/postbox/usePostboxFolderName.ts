/**
 * The name the Postbox list header shows for the folder it is looking at.
 *
 * A system folder arrives as its ROLE (`inbox`, `sent`, …), which has a
 * translated name; a custom folder arrives as an id and carries a user-authored
 * name that is never translated; an unknown role renders verbatim rather than
 * printing a missing message key. Lifted out of PostboxLayout.vue to keep that
 * file under the size cap.
 */

import type { Id } from '@owlat/api/dataModel';

/** Roles with a translated display name in the catalog. */
const NAMED_FOLDER_ROLES: ReadonlySet<string> = new Set([
	'inbox',
	'sent',
	'drafts',
	'trash',
	'spam',
	'archive',
	'snoozed',
]);

/**
 * A folder as a picker lists it: a system folder by its translated name, a
 * custom one by the name its owner gave it. Pure (the translator is passed in).
 */
export function postboxFolderLabel(
	t: (key: string) => string,
	folder: { name: string; role?: string | null }
): string {
	return folder.role && NAMED_FOLDER_ROLES.has(folder.role)
		? t(`components.postbox.postboxLayout.folderRoles.${folder.role}`)
		: folder.name;
}

export function usePostboxFolderName(args: {
	folderRole: Ref<string>;
	folderId: Ref<Id<'mailFolders'> | undefined>;
	customFolders: Ref<ReadonlyArray<{ _id: string; name: string }>>;
}) {
	const { t } = useI18n();
	return computed(() => {
		if (args.folderId.value) {
			const custom = args.customFolders.value.find((f) => f._id === args.folderId.value)?.name;
			return custom ?? t('components.postbox.postboxLayout.folderFallback');
		}
		return NAMED_FOLDER_ROLES.includes(args.folderRole.value)
			? t(`components.postbox.postboxLayout.folderRoles.${args.folderRole.value}`)
			: args.folderRole.value;
	});
}
