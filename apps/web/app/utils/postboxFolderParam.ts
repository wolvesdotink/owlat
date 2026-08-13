import type { Id } from '@owlat/api/dataModel';

/**
 * The postbox routes are `/dashboard/postbox/<folder>` and
 * `/dashboard/postbox/<folder>/<messageId>`, where `<folder>` is either a system
 * folder role (inbox/sent/…) or, for a folder the user made, a `mailFolders` id.
 *
 * Both routes have to discriminate the two, and identically: the layout queries
 * by role OR by folder id, and it can only resolve a custom folder's NAME (for
 * the list header and the mobile back button) when it is handed the id. A route
 * that passes the raw param through as a role therefore queries a role that does
 * not exist and labels the back button with a raw Convex id — which is why this
 * lives here rather than in one of the two pages.
 */

const KNOWN_ROLES = new Set(['inbox', 'sent', 'drafts', 'trash', 'spam', 'archive', 'snoozed']);

export interface PostboxFolderParam {
	/** A system role, or `''` when the param addresses a custom folder. */
	folderRole: string;
	/** Set only for a custom folder. */
	folderId?: Id<'mailFolders'>;
}

/**
 * Split a `[folder]` route param into the props PostboxLayout expects. Takes the
 * raw `route.params` value (a missing param defaults to the inbox).
 */
export function resolvePostboxFolderParam(
	param: string | string[] | undefined
): PostboxFolderParam {
	const folder = String(param ?? 'inbox');
	if (KNOWN_ROLES.has(folder)) return { folderRole: folder };
	return { folderRole: '', folderId: folder as Id<'mailFolders'> };
}
