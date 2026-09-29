/**
 * Mailbox vocabulary shared by the mail tables and the mailbox functions.
 */

import { v } from 'convex/values';
import { literalUnion } from '../literalUnion';
import { mailJobStatusValidator } from '../literalValidators';

/**
 * The six folders every mailbox is provisioned with. Also the accepted
 * `folderRole` values on the read views (`queries.listMessages`,
 * `queries.listThreads`, `search.search`).
 */
export const SYSTEM_FOLDER_ROLES = ['inbox', 'sent', 'drafts', 'trash', 'spam', 'archive'] as const;
export type FolderRole = (typeof SYSTEM_FOLDER_ROLES)[number];
/** The same six roles as a Convex validator, for `mailFolders.role` and the folder-scoped args. */
export const folderRoleValidator = literalUnion(SYSTEM_FOLDER_ROLES);

/**
 * Columns every resumable per-mailbox walk carries: `mailAttachmentBackfillJobs`,
 * `mailBodySearchBackfillJobs` and `mailFilterRunJobs`. Each table adds its own
 * key (`mailboxId`, plus `filterId` for a filter run), its own progress counter
 * and, for body search, the `mode`. The lifecycle over these columns (read,
 * start or restart, cancel) lives in `mail/_jobLifecycle.ts`.
 */
export const mailboxJobFields = {
	status: mailJobStatusValidator,
	// Resumable pagination cursor over `mailMessages` (Convex continueCursor).
	cursor: v.optional(v.string()),
	scannedCount: v.number(),
	startedAt: v.number(),
	updatedAt: v.number(),
	finishedAt: v.optional(v.number()),
	errorMessage: v.optional(v.string()),
};
