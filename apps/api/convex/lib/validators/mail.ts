/**
 * Mailbox vocabulary shared by the mail tables and the mailbox functions.
 */

import { v } from 'convex/values';
import { mailJobStatusValidator } from '../literalValidators';

// The folder, remote-folder and sync vocabulary is part of the worker wire
// contract as well as the mail tables, so it is declared once there.
export {
	EXTERNAL_SYNC_MODES,
	SYSTEM_FOLDER_ROLES,
	externalSyncModeValidator,
	folderRoleValidator,
	remoteFlagChangesValidator,
	remoteFolderRefValidator,
	remoteOpKindValidator,
	remoteSightingValidator,
	type ExternalSyncMode,
	type FolderRole,
} from '@owlat/worker-protocol/fields';

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
