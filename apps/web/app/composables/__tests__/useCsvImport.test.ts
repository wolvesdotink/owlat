import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('papaparse', () => ({
	default: {
		parse: vi.fn(),
	},
}));

import Papa from 'papaparse';
import { createTestI18n } from '~/__tests__/i18n';
import {
	useCsvImport,
	mappableFields,
	type ContactImport,
	type ImportBatchOutcome,
	type ImportResults,
} from '../useCsvImport';

// The composable runs outside a component here, so `useI18n` is stubbed with the
// real catalog's `t` — every message asserted below stays the English on screen.
const { t } = createTestI18n().global;

type PapaMock = {
	mockImplementation: (
		fn: (
			_file: unknown,
			options: {
				complete: (result: { data: string[][]; errors: Array<{ message: string }> }) => void;
				error: (error: { message: string }) => void;
			}
		) => void
	) => void;
};

/**
 * Helper to simulate a CSV file being selected and parsed.
 * Mocks Papa.parse to invoke the `complete` callback with the given headers/rows.
 */
async function simulateFileSelect(
	csvImport: ReturnType<typeof useCsvImport>,
	headers: string[],
	rows: string[][]
) {
	const mockParse = Papa.parse as unknown as PapaMock;
	mockParse.mockImplementation((_file, options) => {
		options.complete({
			data: [headers, ...rows],
			errors: [],
		});
	});

	const fakeFile = new File([''], 'test.csv', { type: 'text/csv' });
	const fakeEvent = { target: { files: [fakeFile] } } as unknown as Event;
	await csvImport.handleFileSelect(fakeEvent);
}

/** A batch the backend committed, in the operation module's envelope. */
function committed(results: Partial<ImportResults>): ImportBatchOutcome {
	return {
		ok: true,
		result: { imported: 0, updated: 0, skipped: 0, failed: 0, errors: [], ...results },
	};
}

describe('useCsvImport', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal('useI18n', () => ({ t }));
	});

	describe('initial state', () => {
		it('has step=upload, isOpen=false, error empty, parsedData=[], csvHeaders=[]', () => {
			const csvImport = useCsvImport();

			expect(csvImport.step.value).toBe('upload');
			expect(csvImport.isOpen.value).toBe(false);
			expect(csvImport.error.value).toBe('');
			expect(csvImport.parsedData.value).toEqual([]);
			expect(csvImport.csvHeaders.value).toEqual([]);
		});

		it('has isEmailMapped=false, previewRows=[], totalRowCount=0', () => {
			const csvImport = useCsvImport();

			expect(csvImport.isEmailMapped.value).toBe(false);
			expect(csvImport.previewRows.value).toEqual([]);
			expect(csvImport.totalRowCount.value).toBe(0);
		});
	});

	describe('open/close/reset', () => {
		it('open() sets isOpen=true and resets state', () => {
			const csvImport = useCsvImport();

			// Mutate some state first
			csvImport.error.value = 'some error';
			csvImport.step.value = 'mapping';
			csvImport.progress.value = 50;

			csvImport.open();

			expect(csvImport.isOpen.value).toBe(true);
			expect(csvImport.step.value).toBe('upload');
			expect(csvImport.error.value).toBe('');
			expect(csvImport.progress.value).toBe(0);
		});

		it('close() sets isOpen=false', () => {
			const csvImport = useCsvImport();
			csvImport.open();
			expect(csvImport.isOpen.value).toBe(true);

			csvImport.close();
			expect(csvImport.isOpen.value).toBe(false);
		});

		it('reset() clears all state back to defaults', () => {
			const csvImport = useCsvImport();

			// Set a bunch of state
			csvImport.step.value = 'complete';
			csvImport.error.value = 'error';
			csvImport.selectedFile.value = new File([''], 'test.csv');
			csvImport.parsedData.value = [['a', 'b']];
			csvImport.csvHeaders.value = ['col1', 'col2'];
			csvImport.columnMapping.value = { 0: 'email' };
			csvImport.handleDuplicates.value = 'update';
			csvImport.progress.value = 75;
			csvImport.results.value = { imported: 1, updated: 0, skipped: 0, failed: 0, errors: [] };
			csvImport.isDragging.value = true;

			csvImport.reset();

			expect(csvImport.step.value).toBe('upload');
			expect(csvImport.error.value).toBe('');
			expect(csvImport.selectedFile.value).toBe(null);
			expect(csvImport.parsedData.value).toEqual([]);
			expect(csvImport.csvHeaders.value).toEqual([]);
			expect(csvImport.columnMapping.value).toEqual({});
			expect(csvImport.handleDuplicates.value).toBe('skip');
			expect(csvImport.progress.value).toBe(0);
			expect(csvImport.results.value).toBe(null);
			expect(csvImport.isDragging.value).toBe(false);
		});
	});

	describe('handleFileSelect', () => {
		it('rejects non-CSV file and sets error', async () => {
			const csvImport = useCsvImport();
			const fakeFile = new File([''], 'test.txt', { type: 'text/plain' });
			const fakeEvent = { target: { files: [fakeFile] } } as unknown as Event;

			await csvImport.handleFileSelect(fakeEvent);

			expect(csvImport.error.value).toBe('Please select a CSV file');
			expect(Papa.parse).not.toHaveBeenCalled();
		});

		it('parses CSV and transitions to mapping step', async () => {
			const csvImport = useCsvImport();

			await simulateFileSelect(csvImport, ['Email', 'Name'], [['a@b.com', 'Alice']]);

			expect(csvImport.step.value).toBe('mapping');
		});

		it('sets csvHeaders from first row and parsedData from remaining rows', async () => {
			const csvImport = useCsvImport();

			await simulateFileSelect(
				csvImport,
				['Email', 'First Name', 'Last Name'],
				[
					['a@b.com', 'Alice', 'Smith'],
					['c@d.com', 'Bob', 'Jones'],
				]
			);

			expect(csvImport.csvHeaders.value).toEqual(['Email', 'First Name', 'Last Name']);
			expect(csvImport.parsedData.value).toEqual([
				['a@b.com', 'Alice', 'Smith'],
				['c@d.com', 'Bob', 'Jones'],
			]);
		});

		it('auto-detects email, firstName, lastName column mapping from headers', async () => {
			const csvImport = useCsvImport();

			await simulateFileSelect(
				csvImport,
				['Email', 'First Name', 'Last Name'],
				[['a@b.com', 'Alice', 'Smith']]
			);

			expect(csvImport.columnMapping.value[0]).toBe('email');
			expect(csvImport.columnMapping.value[1]).toBe('firstName');
			expect(csvImport.columnMapping.value[2]).toBe('lastName');
		});

		it('sets error on parse failure', async () => {
			const csvImport = useCsvImport();

			const mockParse = Papa.parse as unknown as PapaMock;
			mockParse.mockImplementation((_file, options) => {
				options.error({ message: 'File read error' });
			});

			const fakeFile = new File([''], 'test.csv', { type: 'text/csv' });
			const fakeEvent = { target: { files: [fakeFile] } } as unknown as Event;
			await csvImport.handleFileSelect(fakeEvent);

			expect(csvImport.error.value).toBe('CSV parsing error: File read error');
		});

		it('sets error when CSV has fewer than 2 rows', async () => {
			const csvImport = useCsvImport();

			const mockParse = Papa.parse as unknown as PapaMock;
			mockParse.mockImplementation((_file, options) => {
				options.complete({
					data: [['Email']],
					errors: [],
				});
			});

			const fakeFile = new File([''], 'test.csv', { type: 'text/csv' });
			const fakeEvent = { target: { files: [fakeFile] } } as unknown as Event;
			await csvImport.handleFileSelect(fakeEvent);

			expect(csvImport.error.value).toBe(
				'CSV file must have at least a header row and one data row'
			);
		});

		it('sets error when Papa returns parsing errors', async () => {
			const csvImport = useCsvImport();

			const mockParse = Papa.parse as unknown as PapaMock;
			mockParse.mockImplementation((_file, options) => {
				options.complete({
					data: [['Email'], ['a@b.com']],
					errors: [{ message: 'Unexpected quote' }],
				});
			});

			const fakeFile = new File([''], 'test.csv', { type: 'text/csv' });
			const fakeEvent = { target: { files: [fakeFile] } } as unknown as Event;
			await csvImport.handleFileSelect(fakeEvent);

			expect(csvImport.error.value).toBe('CSV parsing error: Unexpected quote');
		});

		it('does nothing when no file is provided', async () => {
			const csvImport = useCsvImport();
			const fakeEvent = { target: { files: [] } } as unknown as Event;

			await csvImport.handleFileSelect(fakeEvent);

			expect(csvImport.step.value).toBe('upload');
			expect(Papa.parse).not.toHaveBeenCalled();
		});
	});

	describe('autoDetectMapping (tested indirectly via handleFileSelect)', () => {
		it.each([
			['Email', 'email'],
			['e-mail', 'email'],
			['User Email Address', 'email'],
		])('maps a lone %j header to %j', async (header, field) => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Company', header], [['Acme', 'a@b.com']]);
			expect(csvImport.columnMapping.value[1]).toBe(field);
		});

		it.each([
			['First Name', 'firstName'],
			['firstname', 'firstName'],
			['first_name', 'firstName'],
			['given name', 'firstName'],
			['Last Name', 'lastName'],
			['lastname', 'lastName'],
			['last_name', 'lastName'],
			['family name', 'lastName'],
			['surname', 'lastName'],
			['Language', 'language'],
			['lang', 'language'],
			['locale', 'language'],
			['preferred_language', 'language'],
		])('maps the %j header to %j', async (header, field) => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email', header], [['a@b.com', 'x']]);
			expect(csvImport.columnMapping.value[1]).toBe(field);
		});

		it("maps unknown headers to 'ignore'", async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(
				csvImport,
				['Email', 'Company', 'Phone'],
				[['a@b.com', 'Acme', '555']]
			);
			expect(csvImport.columnMapping.value[1]).toBe('ignore');
			expect(csvImport.columnMapping.value[2]).toBe('ignore');
		});
	});

	describe('goToPreview', () => {
		it('sets error when email not mapped', () => {
			const csvImport = useCsvImport();
			csvImport.step.value = 'mapping';
			csvImport.columnMapping.value = { 0: 'firstName' };

			csvImport.goToPreview();

			expect(csvImport.error.value).toBe('You must map a column to Email (required)');
			expect(csvImport.step.value).toBe('mapping');
		});

		it('transitions to preview when email is mapped', () => {
			const csvImport = useCsvImport();
			csvImport.step.value = 'mapping';
			csvImport.columnMapping.value = { 0: 'email' };

			csvImport.goToPreview();

			expect(csvImport.step.value).toBe('preview');
		});

		it('clears previous error on success', () => {
			const csvImport = useCsvImport();
			csvImport.step.value = 'mapping';
			csvImport.columnMapping.value = { 0: 'email' };
			csvImport.error.value = 'some previous error';

			csvImport.goToPreview();

			expect(csvImport.error.value).toBe('');
			expect(csvImport.step.value).toBe('preview');
		});
	});

	describe('goBackToMapping', () => {
		it('transitions from preview to mapping', () => {
			const csvImport = useCsvImport();
			csvImport.step.value = 'preview';

			csvImport.goBackToMapping();

			expect(csvImport.step.value).toBe('mapping');
		});
	});

	describe('computed properties', () => {
		it('isEmailMapped reflects columnMapping', () => {
			const csvImport = useCsvImport();

			expect(csvImport.isEmailMapped.value).toBe(false);

			csvImport.columnMapping.value = { 0: 'firstName' };
			expect(csvImport.isEmailMapped.value).toBe(false);

			csvImport.columnMapping.value = { 0: 'email' };
			expect(csvImport.isEmailMapped.value).toBe(true);
		});

		it('previewRows returns first 5 rows', () => {
			const csvImport = useCsvImport();

			csvImport.parsedData.value = [
				['row1'],
				['row2'],
				['row3'],
				['row4'],
				['row5'],
				['row6'],
				['row7'],
			];

			expect(csvImport.previewRows.value.map((r) => r.row)).toEqual([1, 2, 3, 4, 5]);
		});

		it('previewRows returns all rows when fewer than 5', () => {
			const csvImport = useCsvImport();

			csvImport.parsedData.value = [['row1'], ['row2']];

			expect(csvImport.previewRows.value.map((r) => r.row)).toEqual([1, 2]);
		});

		it('previewRows reads the prepared contact, with a missing email flagged', () => {
			const csvImport = useCsvImport();
			csvImport.csvHeaders.value = ['email', 'first', 'last'];
			csvImport.columnMapping.value = { 0: 'email', 1: 'firstName', 2: 'lastName' };
			csvImport.parsedData.value = [
				['a@b.com', 'Alice', 'Smith'],
				['', 'Bob', ''],
			];

			expect(csvImport.previewRows.value).toEqual([
				{
					row: 1,
					contact: { email: 'a@b.com', firstName: 'Alice', lastName: 'Smith' },
					status: 'valid',
				},
				{ row: 2, contact: { email: '', firstName: 'Bob' }, status: 'missing' },
			]);
		});

		it('totalRowCount returns total row count', () => {
			const csvImport = useCsvImport();

			csvImport.parsedData.value = [['row1'], ['row2'], ['row3']];

			expect(csvImport.totalRowCount.value).toBe(3);
		});
	});

	describe('startImport', () => {
		it('sets step to importing and progress to 0', async () => {
			const csvImport = useCsvImport();

			await simulateFileSelect(csvImport, ['Email'], [['a@b.com']]);
			csvImport.columnMapping.value = { 0: 'email' };

			let stepDuringImport = '';
			let progressDuringImport = -1;

			const importFn = vi.fn(async () => {
				stepDuringImport = csvImport.step.value;
				progressDuringImport = csvImport.progress.value;
				return committed({ imported: 1 });
			});

			await csvImport.startImport(importFn);

			expect(stepDuringImport).toBe('importing');
			// Progress starts at 0 and is updated after the batch completes,
			// so during the importFn call it can already be 0 (before update)
			expect(progressDuringImport).toBe(0);
		});

		it('calls importFn with contacts and handleDuplicates', async () => {
			const csvImport = useCsvImport();

			await simulateFileSelect(csvImport, ['Email', 'First Name'], [['a@b.com', 'Alice']]);
			csvImport.columnMapping.value = { 0: 'email', 1: 'firstName' };
			csvImport.handleDuplicates.value = 'update';

			const importFn = vi.fn(async () => committed({ imported: 1 }));

			await csvImport.startImport(importFn);

			expect(importFn).toHaveBeenCalledWith(
				[{ email: 'a@b.com', firstName: 'Alice' }],
				'update',
				{}
			);
		});

		it('aggregates results across batches for >100 rows', async () => {
			const csvImport = useCsvImport();

			// Create 150 rows to trigger 2 batches (100 + 50)
			const rows = Array.from({ length: 150 }, (_, i) => [`user${i}@test.com`]);
			await simulateFileSelect(csvImport, ['Email'], rows);
			csvImport.columnMapping.value = { 0: 'email' };

			const importFn = vi.fn(async (contacts: unknown[]) =>
				committed({ imported: contacts.length })
			);

			const result = await csvImport.startImport(importFn);

			expect(importFn).toHaveBeenCalledTimes(2);
			// First batch: 100 contacts, second batch: 50 contacts
			expect(importFn.mock.calls[0]![0]).toHaveLength(100);
			expect(importFn.mock.calls[1]![0]).toHaveLength(50);
			expect(result).toEqual({
				imported: 150,
				updated: 0,
				skipped: 0,
				failed: 0,
				errors: [],
				addedToList: 0,
			});
		});

		it('updates progress during import', async () => {
			const csvImport = useCsvImport();

			const rows = Array.from({ length: 150 }, (_, i) => [`user${i}@test.com`]);
			await simulateFileSelect(csvImport, ['Email'], rows);
			csvImport.columnMapping.value = { 0: 'email' };

			const importFn = vi.fn(async () => {
				return committed({ imported: 1 });
			});

			// We cannot capture progress mid-call since it updates after importFn returns,
			// so we check the final progress
			await csvImport.startImport(importFn);

			expect(csvImport.progress.value).toBe(100);
		});

		it('sets step=complete and results on success', async () => {
			const csvImport = useCsvImport();

			await simulateFileSelect(csvImport, ['Email'], [['a@b.com'], ['c@d.com']]);
			csvImport.columnMapping.value = { 0: 'email' };

			const importFn = vi.fn(async () => committed({ imported: 2 }));

			await csvImport.startImport(importFn);

			expect(csvImport.step.value).toBe('complete');
			expect(csvImport.results.value).toEqual({
				imported: 2,
				updated: 0,
				skipped: 0,
				failed: 0,
				errors: [],
				addedToList: 0,
			});
		});

		// A throw is folded into the same failure arm as `{ ok: false }`: the row is
		// accounted for and kept for a retry, and the mapping is still there.
		it('accounts a thrown batch as not imported, with the message as the reason', async () => {
			const csvImport = useCsvImport();

			await simulateFileSelect(csvImport, ['Email'], [['a@b.com']]);
			csvImport.columnMapping.value = { 0: 'email' };

			const importFn = vi.fn(async () => {
				throw new Error('Network error');
			});

			await csvImport.startImport(importFn);

			expect(csvImport.step.value).toBe('complete');
			expect(csvImport.failedBatch.value).toEqual({ size: 1, reason: 'Network error' });
			expect(csvImport.notImportedRows.value).toEqual([
				{ row: 1, email: 'a@b.com', attempted: true },
			]);
			expect(csvImport.columnMapping.value).toEqual({ 0: 'email' });
		});

		it('handles non-Error throws', async () => {
			const csvImport = useCsvImport();

			await simulateFileSelect(csvImport, ['Email'], [['a@b.com']]);
			csvImport.columnMapping.value = { 0: 'email' };

			const importFn = vi.fn(async () => {
				throw 'string error';
			});

			await csvImport.startImport(importFn);

			expect(csvImport.failedBatch.value?.reason).toBe('Import failed');
			expect(csvImport.notImportedRowCount.value).toBe(1);
		});

		it('handles no valid contacts (empty emails)', async () => {
			const csvImport = useCsvImport();

			await simulateFileSelect(
				csvImport,
				['Email', 'Name'],
				[
					['', 'Alice'],
					['', 'Bob'],
				]
			);
			csvImport.columnMapping.value = { 0: 'email', 1: 'ignore' };

			const importFn = vi.fn(async () => committed({ imported: 0 }));

			await csvImport.startImport(importFn);

			expect(csvImport.error.value).toBe('No valid contacts found in CSV');
			expect(csvImport.step.value).toBe('mapping');
			expect(importFn).not.toHaveBeenCalled();
		});

		it('maps all contact fields correctly', async () => {
			const csvImport = useCsvImport();

			await simulateFileSelect(
				csvImport,
				['Email', 'First Name', 'Last Name', 'Language'],
				[['a@b.com', 'Alice', 'Smith', 'en']]
			);
			csvImport.columnMapping.value = {
				0: 'email',
				1: 'firstName',
				2: 'lastName',
				3: 'language',
			};

			const importFn = vi.fn(async () => committed({ imported: 1 }));

			await csvImport.startImport(importFn);

			expect(importFn).toHaveBeenCalledWith(
				[{ email: 'a@b.com', firstName: 'Alice', lastName: 'Smith', language: 'en' }],
				'skip',
				{}
			);
		});
	});

	/**
	 * #897: a failed batch used to come back from the page as an all-zero
	 * success, so 201 rows with the second batch failing ended "complete" with
	 * 101 imported, 0 failed and nothing to retry.
	 */
	describe('failed batches', () => {
		const rows201 = Array.from({ length: 201 }, (_, i) => [`user${i + 1}@example.com`]);

		/** Commits every batch except the `failing` call numbers (1-based). */
		function importFailingOn(...failing: number[]) {
			let call = 0;
			return vi.fn(async (contacts: ContactImport[]): Promise<ImportBatchOutcome> => {
				call++;
				if (failing.includes(call)) return { ok: false, reason: 'Too many requests' };
				return committed({ imported: contacts.length });
			});
		}

		async function prepare(rows: string[][] = rows201) {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email'], rows);
			csvImport.columnMapping.value = { 0: 'email' };
			return csvImport;
		}

		it('accounts for all 201 rows and names the failed 100', async () => {
			const csvImport = await prepare();
			const importFn = importFailingOn(2);

			await csvImport.startImport(importFn);

			// Stops at the failed batch: the third one is not sent.
			expect(importFn).toHaveBeenCalledTimes(2);
			expect(csvImport.step.value).toBe('complete');
			const results = csvImport.results.value!;
			expect(results.imported).toBe(100);
			expect(csvImport.failedBatch.value).toEqual({ size: 100, reason: 'Too many requests' });

			const notImported = csvImport.notImportedRows.value;
			const failed = notImported.filter((r) => r.attempted);
			const unsent = notImported.filter((r) => !r.attempted);
			expect(failed.map((r) => r.row)).toEqual(Array.from({ length: 100 }, (_, i) => i + 101));
			expect(failed[0]!.email).toBe('user101@example.com');
			expect(unsent).toEqual([{ row: 201, email: 'user201@example.com', attempted: false }]);

			const accounted =
				results.imported +
				results.updated +
				results.skipped +
				results.failed +
				csvImport.notImportedRowCount.value;
			expect(accounted).toBe(201);
		});

		it('never reports a clean run when a batch failed', async () => {
			const csvImport = await prepare();

			await csvImport.startImport(importFailingOn(2));

			expect(csvImport.notImportedRowCount.value).toBeGreaterThan(0);
			expect(csvImport.failedBatch.value).not.toBeNull();
		});

		it('accounts for a failed first batch too, with nothing committed', async () => {
			const csvImport = await prepare();

			await csvImport.startImport(importFailingOn(1));

			expect(csvImport.results.value!.imported).toBe(0);
			expect(csvImport.notImportedRowCount.value).toBe(201);
		});

		it('counts rows without an email as skipped, so they are accounted for', async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(
				csvImport,
				['Email', 'Name'],
				[
					['a@example.com', 'Ada'],
					['', 'No address'],
					['b@example.com', 'Bea'],
				]
			);
			csvImport.columnMapping.value = { 0: 'email', 1: 'ignore' };
			const importFn = importFailingOn();

			await csvImport.startImport(importFn);

			expect(importFn.mock.calls[0]![0]).toHaveLength(2);
			expect(csvImport.results.value).toMatchObject({ imported: 2, skipped: 1 });
			expect(csvImport.notImportedRowCount.value).toBe(0);
		});

		it('retries only the failed batch and the rows after it', async () => {
			const csvImport = await prepare();
			const firstRun = importFailingOn(2);
			await csvImport.startImport(firstRun);

			const retry = importFailingOn();
			await csvImport.retryFailedRows(retry);

			expect(retry).toHaveBeenCalledTimes(2);
			const resent = retry.mock.calls.flatMap((call) => call[0].map((c) => c.email));
			expect(resent).toHaveLength(101);
			expect(resent[0]).toBe('user101@example.com');
			expect(resent).not.toContain('user1@example.com');
			expect(resent).not.toContain('user100@example.com');

			// Cumulative, and clean now that every row went through.
			expect(csvImport.results.value!.imported).toBe(201);
			expect(csvImport.notImportedRowCount.value).toBe(0);
			expect(csvImport.failedBatch.value).toBeNull();
			expect(csvImport.step.value).toBe('complete');
		});

		it('keeps the retry set, duplicate handling and topic across a retry that fails again', async () => {
			const csvImport = await prepare();
			csvImport.handleDuplicates.value = 'update';
			csvImport.selectGlobalTopic('topic-1');
			await csvImport.startImport(importFailingOn(2));

			const retry = importFailingOn(1);
			await csvImport.retryFailedRows(retry);

			expect(retry).toHaveBeenCalledTimes(1);
			expect(retry.mock.calls[0]![1]).toBe('update');
			expect(retry.mock.calls[0]![2]).toEqual({ topicId: 'topic-1' });
			expect(csvImport.results.value!.imported).toBe(100);
			expect(csvImport.notImportedRowCount.value).toBe(101);
			expect(csvImport.notImportedRows.value[0]!.row).toBe(101);
		});

		it('ignores a second start or retry while a run is in flight', async () => {
			const csvImport = await prepare();
			const importFn = importFailingOn(2);

			await Promise.all([csvImport.startImport(importFn), csvImport.startImport(importFn)]);
			expect(importFn).toHaveBeenCalledTimes(2);

			const retry = importFailingOn();
			await Promise.all([csvImport.retryFailedRows(retry), csvImport.retryFailedRows(retry)]);
			expect(retry).toHaveBeenCalledTimes(2);
			expect(csvImport.results.value!.imported).toBe(201);
		});

		it('stops before any row is written when property registration fails', async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email', 'Company'], [['a@example.com', 'Acme']]);
			csvImport.columnMapping.value = { 0: 'email', 1: 'property' };
			csvImport.goToPreview();

			const importFn = importFailingOn();
			await csvImport.startImport(importFn, async () => ({
				ok: false,
				reason: 'Property limit reached',
			}));

			expect(importFn).not.toHaveBeenCalled();
			expect(csvImport.step.value).toBe('preview');
			expect(csvImport.error.value).toBe(
				'The mapped custom properties could not be registered, so no contacts were imported: Property limit reached'
			);
			expect(csvImport.columnMapping.value).toEqual({ 0: 'email', 1: 'property' });
			expect(csvImport.results.value).toBeNull();
		});
	});

	describe('validation', () => {
		it('produces clean validation for valid CSV', async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(
				csvImport,
				['Email', 'First Name'],
				[
					['alice@example.com', 'Alice'],
					['bob@example.com', 'Bob'],
				]
			);

			csvImport.goToPreview();

			expect(csvImport.validation.value).toEqual({
				validCount: 2,
				invalidEmails: [],
				duplicateEmails: [],
				missingEmails: [],
				totalRows: 2,
			});
		});

		it('detects invalid emails (missing @)', async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email'], [['notanemail'], ['alice@example.com']]);

			csvImport.goToPreview();

			expect(csvImport.validation.value!.invalidEmails).toEqual([{ row: 1, email: 'notanemail' }]);
			expect(csvImport.validation.value!.validCount).toBe(1);
		});

		it('detects invalid emails (missing domain dot)', async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email'], [['alice@example'], ['bob@example.com']]);

			csvImport.goToPreview();

			expect(csvImport.validation.value!.invalidEmails).toEqual([
				{ row: 1, email: 'alice@example' },
			]);
			expect(csvImport.validation.value!.validCount).toBe(1);
		});

		it('detects duplicate emails (case-insensitive, flags 2nd occurrence)', async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(
				csvImport,
				['Email'],
				[['alice@example.com'], ['ALICE@EXAMPLE.COM'], ['bob@example.com']]
			);

			csvImport.goToPreview();

			expect(csvImport.validation.value!.duplicateEmails).toEqual([
				{ row: 2, email: 'ALICE@EXAMPLE.COM' },
			]);
			expect(csvImport.validation.value!.validCount).toBe(2);
		});

		it('detects missing/empty email rows', async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(
				csvImport,
				['Email', 'Name'],
				[
					['alice@example.com', 'Alice'],
					['', 'Bob'],
					['  ', 'Charlie'],
				]
			);

			csvImport.goToPreview();

			expect(csvImport.validation.value!.missingEmails).toEqual([2, 3]);
			expect(csvImport.validation.value!.validCount).toBe(1);
		});

		it('validContactCount reflects only valid, non-duplicate rows', async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(
				csvImport,
				['Email'],
				[
					['alice@example.com'],
					['alice@example.com'], // duplicate
					['notanemail'], // invalid
					['', ''], // missing
					['bob@example.com'],
				]
			);

			csvImport.goToPreview();

			expect(csvImport.validContactCount.value).toBe(2);
		});

		it('canImport is false when no valid contacts exist', async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email'], [['notanemail'], ['also-bad']]);

			csvImport.goToPreview();

			expect(csvImport.canImport.value).toBe(false);
		});

		it('canImport is true when valid contacts exist', async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email'], [['alice@example.com']]);

			csvImport.goToPreview();

			expect(csvImport.canImport.value).toBe(true);
		});

		it('hasValidationWarnings is true when issues exist', async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email'], [['alice@example.com'], ['bad']]);

			csvImport.goToPreview();

			expect(csvImport.hasValidationWarnings.value).toBe(true);
		});

		it('hasValidationWarnings is false when no issues', async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email'], [['alice@example.com']]);

			csvImport.goToPreview();

			expect(csvImport.hasValidationWarnings.value).toBe(false);
		});

		it('validation runs when goToPreview() is called', async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email'], [['alice@example.com']]);

			expect(csvImport.validation.value).toBe(null);

			csvImport.goToPreview();

			expect(csvImport.validation.value).not.toBe(null);
			expect(csvImport.step.value).toBe('preview');
		});

		it('validation is reset on reset()', async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email'], [['alice@example.com']]);
			csvImport.goToPreview();

			expect(csvImport.validation.value).not.toBe(null);

			csvImport.reset();

			expect(csvImport.validation.value).toBe(null);
		});
	});

	describe('mappableFields export', () => {
		it('contains all 7 field options', () => {
			expect(mappableFields).toHaveLength(7);
			expect(mappableFields.map((f) => f.value)).toEqual([
				'email',
				'firstName',
				'lastName',
				'language',
				'topic',
				'property',
				'ignore',
			]);
		});

		// Module-scope registry: the labels are message keys the import modal
		// renders through `t()`, so the copy is asserted through the catalog.
		it('has correct labels', () => {
			expect(mappableFields[0]).toEqual({
				value: 'email',
				label: 'shared.useCsvImport.fields.email',
			});
			expect(mappableFields[5]).toEqual({
				value: 'property',
				label: 'shared.useCsvImport.fields.property',
			});
			expect(mappableFields[6]).toEqual({
				value: 'ignore',
				label: 'shared.useCsvImport.fields.ignore',
			});
			// Every label is a key the real catalog carries.
			for (const field of mappableFields) expect(t(field.label)).not.toBe(field.label);
		});
	});

	describe('custom properties', () => {
		it('collects columns mapped to "property" into row.properties keyed by header', async () => {
			const csvImport = useCsvImport();

			await simulateFileSelect(
				csvImport,
				['Email', 'Company', 'Plan'],
				[['a@b.com', 'Acme', 'pro']]
			);
			csvImport.columnMapping.value = { 0: 'email', 1: 'property', 2: 'property' };

			const importFn = vi.fn(async () => committed({ imported: 1 }));

			await csvImport.startImport(importFn);

			expect(importFn).toHaveBeenCalledWith(
				[{ email: 'a@b.com', properties: { Company: 'Acme', Plan: 'pro' } }],
				'skip',
				{}
			);
		});

		it('omits properties when no property columns have values', async () => {
			const csvImport = useCsvImport();

			await simulateFileSelect(csvImport, ['Email', 'Company'], [['a@b.com', '']]);
			csvImport.columnMapping.value = { 0: 'email', 1: 'property' };

			const importFn = vi.fn(async () => committed({ imported: 1 }));

			await csvImport.startImport(importFn);

			expect(importFn).toHaveBeenCalledWith([{ email: 'a@b.com' }], 'skip', {});
		});

		it('getMappedPropertyKeys returns distinct header keys for property columns', async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(
				csvImport,
				['Email', 'Company', 'Plan'],
				[['a@b.com', 'Acme', 'pro']]
			);
			csvImport.columnMapping.value = { 0: 'email', 1: 'property', 2: 'property' };

			expect(csvImport.getMappedPropertyKeys()).toEqual(['Company', 'Plan']);
		});

		it('getMappedPropertyKeys is empty when no property columns are mapped', async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email', 'Company'], [['a@b.com', 'Acme']]);
			csvImport.columnMapping.value = { 0: 'email', 1: 'ignore' };

			expect(csvImport.getMappedPropertyKeys()).toEqual([]);
		});

		it('calls registerProperties with mapped keys before importing', async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email', 'Company'], [['a@b.com', 'Acme']]);
			csvImport.columnMapping.value = { 0: 'email', 1: 'property' };

			const order: string[] = [];
			const registerProperties = vi.fn(async (keys: string[]) => {
				order.push(`register:${keys.join(',')}`);
				return { ok: true as const, result: undefined };
			});
			const importFn = vi.fn(async () => {
				order.push('import');
				return committed({ imported: 1 });
			});

			await csvImport.startImport(importFn, registerProperties);

			expect(registerProperties).toHaveBeenCalledWith(['Company']);
			expect(order).toEqual(['register:Company', 'import']);
		});

		it('does not call registerProperties when no property columns are mapped', async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email'], [['a@b.com']]);
			csvImport.columnMapping.value = { 0: 'email' };

			const registerProperties = vi.fn(async () => ({ ok: true as const, result: undefined }));
			const importFn = vi.fn(async () => committed({ imported: 1 }));

			await csvImport.startImport(importFn, registerProperties);

			expect(registerProperties).not.toHaveBeenCalled();
		});
	});

	/**
	 * #1042: `email` and `secondary_email` were both auto-mapped to Email. The
	 * preview and validation read the first column, serialization let the last
	 * nonempty one win, so the preview showed contact0@ and the import wrote
	 * billing0@.
	 */
	describe('one column per identity field', () => {
		// Ten rows with distinct addresses; rows 2, 5 and 8 have a blank secondary cell and
		// row 10 has no primary address at all.
		const rows = Array.from({ length: 10 }, (_, i) => [
			i === 9 ? '' : `contact${i}@owlat.example`,
			i % 3 === 1 ? '' : `billing${i}@owlat.example`,
		]);

		async function previewAndImport(csvImport: ReturnType<typeof useCsvImport>) {
			csvImport.goToPreview();
			expect(csvImport.step.value).toBe('preview');
			const previewed = csvImport.preparedRows.value.map((r) => r.contact.email);
			const importFn = vi.fn(async (contacts: ContactImport[]) =>
				committed({ imported: contacts.length })
			);
			await csvImport.startImport(importFn);
			const submitted = importFn.mock.calls.flatMap(([contacts]) => contacts);
			return { previewed, submitted };
		}

		it('auto-maps only the email column to Email and keeps secondary_email as a property', async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['email', 'secondary_email'], rows);

			expect(csvImport.columnMapping.value).toEqual({ 0: 'email', 1: 'property' });
			expect(csvImport.emailSourceColumn.value).toBe('email');
		});

		it('previews and submits the same address for every row, blank secondary cells included', async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['email', 'secondary_email'], rows);

			const { previewed, submitted } = await previewAndImport(csvImport);

			// The preview table is the first five prepared rows.
			expect(csvImport.previewRows.value.map((r) => r.contact.email)).toEqual(
				previewed.slice(0, 5)
			);
			// Every row with an address is sent with exactly the previewed address.
			expect(submitted.map((c) => c.email)).toEqual(previewed.filter(Boolean));
			expect(submitted.map((c) => c.email)).toEqual(
				Array.from({ length: 9 }, (_, i) => `contact${i}@owlat.example`)
			);
			expect(submitted[0]!.properties).toEqual({ secondary_email: 'billing0@owlat.example' });
			expect(submitted[1]!.properties).toBeUndefined();
			// Row 10 has only a secondary address: it is missing, not imported as billing9@.
			expect(csvImport.validation.value?.missingEmails).toEqual([10]);
			expect(csvImport.validation.value?.validCount).toBe(9);
		});

		it('moves Email to the picked column and drops the old one to Custom property', async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['email', 'secondary_email'], rows);

			expect(csvImport.mapColumn(1, 'email')).toEqual([0]);

			expect(csvImport.columnMapping.value).toEqual({ 0: 'property', 1: 'email' });
			expect(csvImport.emailSourceColumn.value).toBe('secondary_email');
			const { previewed, submitted } = await previewAndImport(csvImport);
			expect(submitted.map((c) => c.email)).toEqual(previewed.filter(Boolean));
			expect(submitted[0]).toEqual({
				email: 'billing0@owlat.example',
				properties: { email: 'contact0@owlat.example' },
			});
			// Rows with a blank secondary cell now have no address, so they are not sent.
			expect(csvImport.validation.value?.missingEmails).toEqual([2, 5, 8]);
		});

		it.each([
			['firstName', ['first_name', 'given_name'], ['Ada', 'Augusta']],
			['lastName', ['last_name', 'family_name'], ['Lovelace', 'King']],
			['language', ['language', 'locale'], ['en', 'de']],
		] as const)('keeps %s on one column when it is moved', async (field, headers, values) => {
			const csvImport = useCsvImport();
			await simulateFileSelect(
				csvImport,
				['email', ...headers],
				[['ada@owlat.example', ...values]]
			);
			csvImport.mapColumn(1, field);

			csvImport.mapColumn(2, field);

			expect(csvImport.columnMapping.value).toEqual({ 0: 'email', 1: 'property', 2: field });
			const { submitted } = await previewAndImport(csvImport);
			expect(submitted[0]).toEqual({
				email: 'ada@owlat.example',
				[field]: values[1],
				properties: { [headers[0]]: values[0] },
			});
		});

		it('blocks Next while a scalar field is mapped from two columns', () => {
			const csvImport = useCsvImport();
			csvImport.step.value = 'mapping';
			csvImport.csvHeaders.value = ['email', 'secondary_email'];
			csvImport.parsedData.value = rows;
			csvImport.columnMapping.value = { 0: 'email', 1: 'email' };

			csvImport.goToPreview();

			expect(csvImport.step.value).toBe('mapping');
			expect(csvImport.error.value).toBe(
				'Email is mapped to more than one column. Map it to one column only.'
			);
		});
	});
});
