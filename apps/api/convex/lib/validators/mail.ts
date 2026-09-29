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

/**
 * A folder on the REMOTE server of a connected external account, named the
 * way the local side can name it: a system folder by role (the mail-sync
 * worker maps it through its own folder discovery), or a user folder by its
 * chain of local folder names, outermost first (the worker joins them with the
 * server's delimiter and creates the folder when it is missing).
 */
export const remoteFolderRefValidator = v.union(
	v.object({ role: folderRoleValidator }),
	v.object({ path: v.array(v.string()) }),
	// A folder the worker has mapped, by its exact remote name.
	v.object({ remote: v.string() })
);

/** 'full' — two-way sync; 'incoming' — only new mail comes in. */
export const EXTERNAL_SYNC_MODES = ['full', 'incoming'] as const;
export type ExternalSyncMode = (typeof EXTERNAL_SYNC_MODES)[number];
export const externalSyncModeValidator = literalUnion(EXTERNAL_SYNC_MODES);

/** The flags a remote write-back sets (`true`) or clears (`false`); absent ⇒ untouched. */
export const remoteFlagChangesValidator = v.object({
	seen: v.optional(v.boolean()),
	flagged: v.optional(v.boolean()),
	answered: v.optional(v.boolean()),
});
