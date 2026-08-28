import { describe, expect, it } from 'vitest';
import { MAX_ARCHIVE_IMPORT_BYTES } from '@owlat/shared/mboxArchive';
import {
	ARCHIVE_IMPORT_ACCEPT,
	archiveFormatForFilename,
	archiveImportRefusalKey,
	archiveImportSummary,
	archiveRejectionKey,
	isArchiveImportRunning,
	rejectArchiveFile,
	type ArchiveImportJob,
} from '../postboxArchiveImport';

function job(overrides: Partial<ArchiveImportJob> = {}): ArchiveImportJob {
	return {
		status: 'importing',
		filename: 'All mail.mbox',
		totalBytes: 1000,
		cursorBytes: 500,
		messagesImported: 12,
		messagesSkipped: 0,
		labelsCreated: 0,
		percent: 50,
		...overrides,
	};
}

describe('archiveFormatForFilename', () => {
	it('routes by extension, case-insensitively', () => {
		expect(archiveFormatForFilename('All mail.mbox')).toBe('mbox');
		expect(archiveFormatForFilename('SAVED.EML')).toBe('eml');
	});

	it('refuses anything else', () => {
		expect(archiveFormatForFilename('takeout.zip')).toBeNull();
		expect(archiveFormatForFilename('notes.txt')).toBeNull();
		expect(archiveFormatForFilename('mbox')).toBeNull();
	});

	it('offers both formats in the picker', () => {
		expect(ARCHIVE_IMPORT_ACCEPT).toBe('.mbox,.eml');
	});
});

describe('rejectArchiveFile', () => {
	it('accepts an archive of a supported type and size', () => {
		expect(rejectArchiveFile({ name: 'All mail.mbox', size: 1024 })).toBeNull();
	});

	it('names a Takeout zip specifically, so the user knows what to do next', () => {
		expect(rejectArchiveFile({ name: 'takeout-20260101.zip', size: 1024 })).toBe('zip');
	});

	it('rejects an unsupported type, an empty file and an over-size archive', () => {
		expect(rejectArchiveFile({ name: 'notes.txt', size: 10 })).toBe('unsupported_type');
		expect(rejectArchiveFile({ name: 'empty.mbox', size: 0 })).toBe('empty');
		expect(rejectArchiveFile({ name: 'huge.mbox', size: MAX_ARCHIVE_IMPORT_BYTES + 1 })).toBe(
			'too_large'
		);
	});

	it('accepts an archive exactly at the ceiling the server enforces', () => {
		expect(rejectArchiveFile({ name: 'big.mbox', size: MAX_ARCHIVE_IMPORT_BYTES })).toBeNull();
	});
});

describe('archiveImportSummary', () => {
	it('counts messages while the bar counts bytes', () => {
		expect(archiveImportSummary(job())).toEqual({
			key: 'shared.archiveImport.summaryImporting',
			params: { messages: 12 },
		});
	});

	it('says what landed when the import finishes', () => {
		expect(archiveImportSummary(job({ status: 'completed', messagesImported: 40 }))).toEqual({
			key: 'shared.archiveImport.summaryCompleted',
			params: { messages: 40 },
		});
	});

	it('never hides skipped messages', () => {
		expect(
			archiveImportSummary(job({ status: 'completed', messagesImported: 40, messagesSkipped: 3 }))
		).toEqual({
			key: 'shared.archiveImport.summaryCompletedWithSkips',
			params: { messages: 40, skipped: 3 },
		});
	});

	it('reports what a failed or cancelled run still managed to import', () => {
		expect(archiveImportSummary(job({ status: 'failed', messagesImported: 7 })).key).toBe(
			'shared.archiveImport.summaryFailed'
		);
		expect(archiveImportSummary(job({ status: 'cancelled', messagesImported: 7 })).params).toEqual({
			messages: 7,
		});
	});

	it('keys every refusal and rejection through the catalog', () => {
		expect(archiveImportRefusalKey('already_running')).toBe(
			'shared.archiveImport.refused.already_running'
		);
		expect(archiveRejectionKey('zip')).toBe('shared.archiveImport.rejected.zip');
	});
});

describe('isArchiveImportRunning', () => {
	it('is true only while a job is importing', () => {
		expect(isArchiveImportRunning(job())).toBe(true);
		expect(isArchiveImportRunning(job({ status: 'completed' }))).toBe(false);
		expect(isArchiveImportRunning(null)).toBe(false);
		expect(isArchiveImportRunning(undefined)).toBe(false);
	});
});
