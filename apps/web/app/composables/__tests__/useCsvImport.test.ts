import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('papaparse', () => ({
	default: {
		parse: vi.fn(),
	},
}));

import Papa from 'papaparse';
import { useCsvImport, mappableFields } from '../useCsvImport';

type PapaMock = {
	mockImplementation: (fn: (_file: unknown, options: {
		complete: (result: { data: string[][]; errors: Array<{ message: string }> }) => void;
		error: (error: { message: string }) => void;
	}) => void) => void;
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

describe('useCsvImport', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('initial state', () => {
		it('has step=upload, isOpen=false, error empty, parsedData=[], csvHeaders=[]', async () => {
			const csvImport = useCsvImport();

			expect(csvImport.step.value).toBe('upload');
			expect(csvImport.isOpen.value).toBe(false);
			expect(csvImport.error.value).toBe('');
			expect(csvImport.parsedData.value).toEqual([]);
			expect(csvImport.csvHeaders.value).toEqual([]);
		});

		it('has isEmailMapped=false, previewRows=[], totalRowCount=0', async () => {
			const csvImport = useCsvImport();

			expect(csvImport.isEmailMapped.value).toBe(false);
			expect(csvImport.previewRows.value).toEqual([]);
			expect(csvImport.totalRowCount.value).toBe(0);
		});
	});

	describe('open/close/reset', () => {
		it('open() sets isOpen=true and resets state', async () => {
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

		it('close() sets isOpen=false', async () => {
			const csvImport = useCsvImport();
			csvImport.open();
			expect(csvImport.isOpen.value).toBe(true);

			csvImport.close();
			expect(csvImport.isOpen.value).toBe(false);
		});

		it('reset() clears all state back to defaults', async () => {
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
		it("maps 'Email' header to 'email'", async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email'], [['a@b.com']]);
			expect(csvImport.columnMapping.value[0]).toBe('email');
		});

		it("maps 'e-mail' header to 'email'", async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['e-mail'], [['a@b.com']]);
			expect(csvImport.columnMapping.value[0]).toBe('email');
		});

		it("maps header containing 'email' to 'email'", async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['User Email Address'], [['a@b.com']]);
			expect(csvImport.columnMapping.value[0]).toBe('email');
		});

		it("maps 'First Name' header to 'firstName'", async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email', 'First Name'], [['a@b.com', 'Alice']]);
			expect(csvImport.columnMapping.value[1]).toBe('firstName');
		});

		it("maps 'firstname' header to 'firstName'", async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email', 'firstname'], [['a@b.com', 'Alice']]);
			expect(csvImport.columnMapping.value[1]).toBe('firstName');
		});

		it("maps 'first_name' header to 'firstName'", async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email', 'first_name'], [['a@b.com', 'Alice']]);
			expect(csvImport.columnMapping.value[1]).toBe('firstName');
		});

		it("maps 'given name' header to 'firstName'", async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email', 'given name'], [['a@b.com', 'Alice']]);
			expect(csvImport.columnMapping.value[1]).toBe('firstName');
		});

		it("maps 'Last Name' header to 'lastName'", async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email', 'Last Name'], [['a@b.com', 'Smith']]);
			expect(csvImport.columnMapping.value[1]).toBe('lastName');
		});

		it("maps 'lastname' header to 'lastName'", async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email', 'lastname'], [['a@b.com', 'Smith']]);
			expect(csvImport.columnMapping.value[1]).toBe('lastName');
		});

		it("maps 'last_name' header to 'lastName'", async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email', 'last_name'], [['a@b.com', 'Smith']]);
			expect(csvImport.columnMapping.value[1]).toBe('lastName');
		});

		it("maps 'family name' header to 'lastName'", async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email', 'family name'], [['a@b.com', 'Smith']]);
			expect(csvImport.columnMapping.value[1]).toBe('lastName');
		});

		it("maps 'surname' header to 'lastName'", async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email', 'surname'], [['a@b.com', 'Smith']]);
			expect(csvImport.columnMapping.value[1]).toBe('lastName');
		});

		it("maps 'Language' header to 'language'", async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email', 'Language'], [['a@b.com', 'en']]);
			expect(csvImport.columnMapping.value[1]).toBe('language');
		});

		it("maps 'lang' header to 'language'", async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email', 'lang'], [['a@b.com', 'en']]);
			expect(csvImport.columnMapping.value[1]).toBe('language');
		});

		it("maps 'locale' header to 'language'", async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email', 'locale'], [['a@b.com', 'en']]);
			expect(csvImport.columnMapping.value[1]).toBe('language');
		});

		it("maps 'preferred_language' header to 'language'", async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email', 'preferred_language'], [['a@b.com', 'en']]);
			expect(csvImport.columnMapping.value[1]).toBe('language');
		});

		it("maps unknown headers to 'ignore'", async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email', 'Company', 'Phone'], [['a@b.com', 'Acme', '555']]);
			expect(csvImport.columnMapping.value[1]).toBe('ignore');
			expect(csvImport.columnMapping.value[2]).toBe('ignore');
		});
	});

	describe('goToPreview', () => {
		it('sets error when email not mapped', async () => {
			const csvImport = useCsvImport();
			csvImport.step.value = 'mapping';
			csvImport.columnMapping.value = { 0: 'firstName' };

			csvImport.goToPreview();

			expect(csvImport.error.value).toBe('You must map a column to Email (required)');
			expect(csvImport.step.value).toBe('mapping');
		});

		it('transitions to preview when email is mapped', async () => {
			const csvImport = useCsvImport();
			csvImport.step.value = 'mapping';
			csvImport.columnMapping.value = { 0: 'email' };

			csvImport.goToPreview();

			expect(csvImport.step.value).toBe('preview');
		});

		it('clears previous error on success', async () => {
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
		it('transitions from preview to mapping', async () => {
			const csvImport = useCsvImport();
			csvImport.step.value = 'preview';

			csvImport.goBackToMapping();

			expect(csvImport.step.value).toBe('mapping');
		});
	});

	describe('getMappedValue', () => {
		it('returns value from correct column based on mapping', async () => {
			const csvImport = useCsvImport();
			csvImport.columnMapping.value = { 0: 'email', 1: 'firstName', 2: 'lastName' };

			const row = ['a@b.com', 'Alice', 'Smith'];

			expect(csvImport.getMappedValue(row, 'email')).toBe('a@b.com');
			expect(csvImport.getMappedValue(row, 'firstName')).toBe('Alice');
			expect(csvImport.getMappedValue(row, 'lastName')).toBe('Smith');
		});

		it("returns '\u2014' when field not mapped", async () => {
			const csvImport = useCsvImport();
			csvImport.columnMapping.value = { 0: 'email' };

			const row = ['a@b.com'];

			expect(csvImport.getMappedValue(row, 'firstName')).toBe('\u2014');
		});

		it("returns '\u2014' when cell is empty", async () => {
			const csvImport = useCsvImport();
			csvImport.columnMapping.value = { 0: 'email', 1: 'firstName' };

			const row = ['a@b.com', ''];

			expect(csvImport.getMappedValue(row, 'firstName')).toBe('\u2014');
		});
	});

	describe('computed properties', () => {
		it('isEmailMapped reflects columnMapping', async () => {
			const csvImport = useCsvImport();

			expect(csvImport.isEmailMapped.value).toBe(false);

			csvImport.columnMapping.value = { 0: 'firstName' };
			expect(csvImport.isEmailMapped.value).toBe(false);

			csvImport.columnMapping.value = { 0: 'email' };
			expect(csvImport.isEmailMapped.value).toBe(true);
		});

		it('previewRows returns first 5 rows', async () => {
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

			expect(csvImport.previewRows.value).toEqual([
				['row1'],
				['row2'],
				['row3'],
				['row4'],
				['row5'],
			]);
		});

		it('previewRows returns all rows when fewer than 5', async () => {
			const csvImport = useCsvImport();

			csvImport.parsedData.value = [['row1'], ['row2']];

			expect(csvImport.previewRows.value).toEqual([['row1'], ['row2']]);
		});

		it('totalRowCount returns total row count', async () => {
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
				return { imported: 1, updated: 0, skipped: 0, failed: 0, errors: [] };
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

			const importFn = vi.fn(async () => ({
				imported: 1,
				updated: 0,
				skipped: 0,
				failed: 0,
				errors: [],
			}));

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

			const importFn = vi.fn(async (contacts: unknown[]) => ({
				imported: contacts.length,
				updated: 0,
				skipped: 0,
				failed: 0,
				errors: [],
			}));

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
				const result = { imported: 1, updated: 0, skipped: 0, failed: 0, errors: [] };
				return result;
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

			const importFn = vi.fn(async () => ({
				imported: 2,
				updated: 0,
				skipped: 0,
				failed: 0,
				errors: [],
			}));

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

		it('sets error and step=mapping on failure', async () => {
			const csvImport = useCsvImport();

			await simulateFileSelect(csvImport, ['Email'], [['a@b.com']]);
			csvImport.columnMapping.value = { 0: 'email' };

			const importFn = vi.fn(async () => {
				throw new Error('Network error');
			});

			await expect(csvImport.startImport(importFn)).rejects.toThrow('Network error');

			expect(csvImport.error.value).toBe('Network error');
			expect(csvImport.step.value).toBe('mapping');
		});

		it('handles non-Error throws', async () => {
			const csvImport = useCsvImport();

			await simulateFileSelect(csvImport, ['Email'], [['a@b.com']]);
			csvImport.columnMapping.value = { 0: 'email' };

			const importFn = vi.fn(async () => {
				throw 'string error';
			});

			await expect(csvImport.startImport(importFn)).rejects.toBe('string error');

			expect(csvImport.error.value).toBe('Import failed');
			expect(csvImport.step.value).toBe('mapping');
		});

		it('handles no valid contacts (empty emails)', async () => {
			const csvImport = useCsvImport();

			await simulateFileSelect(csvImport, ['Email', 'Name'], [['', 'Alice'], ['', 'Bob']]);
			csvImport.columnMapping.value = { 0: 'email', 1: 'ignore' };

			const importFn = vi.fn(async () => ({
				imported: 0,
				updated: 0,
				skipped: 0,
				failed: 0,
				errors: [],
			}));

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

			const importFn = vi.fn(async () => ({
				imported: 1,
				updated: 0,
				skipped: 0,
				failed: 0,
				errors: [],
			}));

			await csvImport.startImport(importFn);

			expect(importFn).toHaveBeenCalledWith(
				[{ email: 'a@b.com', firstName: 'Alice', lastName: 'Smith', language: 'en' }],
				'skip',
				{}
			);
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

			expect(csvImport.validation.value!.invalidEmails).toEqual([
				{ row: 1, email: 'notanemail' },
			]);
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
					['notanemail'],        // invalid
					['', ''],              // missing
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
		it('contains all 7 field options', async () => {
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

		it('has correct labels', async () => {
			expect(mappableFields[0]).toEqual({ value: 'email', label: 'Email (required)' });
			expect(mappableFields[5]).toEqual({ value: 'property', label: 'Custom property' });
			expect(mappableFields[6]).toEqual({ value: 'ignore', label: '\u2014 Ignore this column' });
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

			const importFn = vi.fn(async () => ({
				imported: 1,
				updated: 0,
				skipped: 0,
				failed: 0,
				errors: [],
			}));

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

			const importFn = vi.fn(async () => ({
				imported: 1,
				updated: 0,
				skipped: 0,
				failed: 0,
				errors: [],
			}));

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
			});
			const importFn = vi.fn(async () => {
				order.push('import');
				return { imported: 1, updated: 0, skipped: 0, failed: 0, errors: [] };
			});

			await csvImport.startImport(importFn, registerProperties);

			expect(registerProperties).toHaveBeenCalledWith(['Company']);
			expect(order).toEqual(['register:Company', 'import']);
		});

		it('does not call registerProperties when no property columns are mapped', async () => {
			const csvImport = useCsvImport();
			await simulateFileSelect(csvImport, ['Email'], [['a@b.com']]);
			csvImport.columnMapping.value = { 0: 'email' };

			const registerProperties = vi.fn(async () => {});
			const importFn = vi.fn(async () => ({
				imported: 1,
				updated: 0,
				skipped: 0,
				failed: 0,
				errors: [],
			}));

			await csvImport.startImport(importFn, registerProperties);

			expect(registerProperties).not.toHaveBeenCalled();
		});
	});
});
