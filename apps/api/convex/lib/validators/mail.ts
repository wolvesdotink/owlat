/**
 * Mailbox vocabulary shared by the mail tables and the mailbox functions.
 */

import { literalUnion } from '../literalUnion';

/**
 * The six folders every mailbox is provisioned with. Also the accepted
 * `folderRole` values on the read views (`queries.listMessages`,
 * `queries.listThreads`, `search.search`).
 */
export const SYSTEM_FOLDER_ROLES = ['inbox', 'sent', 'drafts', 'trash', 'spam', 'archive'] as const;
export type FolderRole = (typeof SYSTEM_FOLDER_ROLES)[number];
/** The same six roles as a Convex validator, for `mailFolders.role` and the folder-scoped args. */
export const folderRoleValidator = literalUnion(SYSTEM_FOLDER_ROLES);
