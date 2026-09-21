/**
 * Upload-based archive import (idea 50) — everything the wizard card can decide
 * without a network call.
 *
 * The card itself is a file input, a progress bar and a sentence. All three are
 * derived here so they can be tested without mounting a Convex-backed page: what
 * the picker accepts, whether a chosen file is importable at all, and what the
 * sentence under the bar should say about a running or finished job.
 *
 * Every string is a `{key, params}` pair — module scope cannot call `useI18n` —
 * resolved by the component at the render boundary.
 */

import { MAX_ARCHIVE_IMPORT_BYTES } from '@owlat/shared/mboxArchive';

export type ArchiveImportFormat = 'mbox' | 'eml';

/** The `accept` attribute of the file input. */
export const ARCHIVE_IMPORT_ACCEPT = '.mbox,.eml';

/**
 * Which importer a chosen file goes to, by extension.
 *
 * Extension rather than MIME type: browsers report `.mbox` as
 * `application/octet-stream`, as an empty string, or as any of three
 * provider-specific types depending on the platform, so sniffing the type
 * rejects perfectly good archives.
 */
export function archiveFormatForFilename(filename: string): ArchiveImportFormat | null {
	const lower = filename.toLowerCase();
	if (lower.endsWith('.mbox')) return 'mbox';
	if (lower.endsWith('.eml')) return 'eml';
	return null;
}

/** Why a chosen file cannot be imported, or `null` when it can. */
export type ArchiveImportRejection = 'zip' | 'unsupported_type' | 'too_large' | 'empty';

/**
 * Vet a file before a byte of it is uploaded.
 *
 * A Takeout `.zip` gets its OWN rejection rather than the generic one: it is by
 * far the likeliest thing a user drops here, and "unzip it and pick the .mbox
 * inside" is a sentence that gets them home, where "unsupported file" is not.
 */
export function rejectArchiveFile(file: {
	name: string;
	size: number;
}): ArchiveImportRejection | null {
	if (file.name.toLowerCase().endsWith('.zip')) return 'zip';
	if (!archiveFormatForFilename(file.name)) return 'unsupported_type';
	if (file.size <= 0) return 'empty';
	if (file.size > MAX_ARCHIVE_IMPORT_BYTES) return 'too_large';
	return null;
}

/** The job row as the card reads it (mirrors `mail.archiveImport.getStatus`). */
export interface ArchiveImportJob {
	status: 'importing' | 'completed' | 'failed' | 'cancelled';
	filename: string;
	totalBytes: number;
	cursorBytes: number;
	messagesImported: number;
	messagesSkipped: number;
	labelsCreated: number;
	percent: number;
	lastError?: string;
}

/** A localizable sentence: catalog key plus its interpolation values. */
export interface ArchiveImportMessage {
	key: string;
	params?: Record<string, string | number>;
}

/**
 * The line under the progress bar.
 *
 * A running import reports MESSAGES, not bytes, because that is what the user
 * cares about — while the bar tracks bytes, which is the only measure that
 * exists before the archive has been read. A finished one reports what actually
 * landed, skipped messages included: an import that silently dropped duplicates
 * would leave the user counting mail to find out.
 */
export function archiveImportSummary(job: ArchiveImportJob): ArchiveImportMessage {
	if (job.status === 'importing') {
		return {
			key: 'shared.archiveImport.summaryImporting',
			params: { messages: job.messagesImported },
		};
	}
	if (job.status === 'failed') {
		return {
			key: 'shared.archiveImport.summaryFailed',
			params: { messages: job.messagesImported },
		};
	}
	if (job.status === 'cancelled') {
		return {
			key: 'shared.archiveImport.summaryCancelled',
			params: { messages: job.messagesImported },
		};
	}
	if (job.messagesSkipped > 0) {
		return {
			key: 'shared.archiveImport.summaryCompletedWithSkips',
			params: { messages: job.messagesImported, skipped: job.messagesSkipped },
		};
	}
	return {
		key: 'shared.archiveImport.summaryCompleted',
		params: { messages: job.messagesImported },
	};
}

/** Catalog key for a refusal from `mail.archiveImport.start`. */
export function archiveImportRefusalKey(
	reason: 'empty' | 'too_large' | 'already_running' | 'mailbox_inactive'
): string {
	return `shared.archiveImport.refused.${reason}`;
}

/** Catalog key for a file the card refused before uploading it. */
export function archiveRejectionKey(rejection: ArchiveImportRejection): string {
	return `shared.archiveImport.rejected.${rejection}`;
}

/** Whether the card should keep polling / show its cancel affordance. */
export function isArchiveImportRunning(job: ArchiveImportJob | null | undefined): boolean {
	return job?.status === 'importing';
}
