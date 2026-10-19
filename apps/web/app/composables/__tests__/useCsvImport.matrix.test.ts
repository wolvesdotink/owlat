import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isReactive, isProxy } from 'vue';
import { createTestI18n } from '~/__tests__/i18n';
import { prepareCsvRows, type ColumnMapping } from '~/utils/csvImportMapping';
import { useCsvImport, type ContactImport, type ImportBatchOutcome } from '../useCsvImport';

// The parsed cell matrix is immutable, so it sits in a shallowRef, and the
// preview prepares only the rows it shows. The oracle is the transform the
// import used before: `prepareCsvRows` over the whole matrix, preview = its head.
const { t } = createTestI18n().global;

const headers = ['Email', 'First name', 'Plan', '', 'Lists'];

// Duplicates (one differing only in case), an invalid and a missing address,
// both inside the five preview rows and after them.
const rows: string[][] = [
	['ada@owlat.example', 'Ada', 'pro', 'x', 'News'],
	[' ADA@owlat.example ', 'Ada again', '', 'x', ''],
	['not-an-email', 'Nope', 'free', '', 'News, Beta'],
	['', 'Nobody', 'free', '', ''],
	['grace@owlat.example', ' Grace ', 'team', '', 'Beta'],
	['grace@owlat.example', 'Grace twice', 'team', '', ''],
	['linus@owlat.example', '', '', '', 'News'],
	['bad@', 'Bad', '', '', ''],
	['', '', 'orphan', '', ''],
	['ada@OWLAT.example', 'Ada thrice', '', '', ''],
];

const mappings: [string, ColumnMapping][] = [
	['detected', { 0: 'email', 1: 'firstName', 2: 'property', 3: 'ignore', 4: 'topic' }],
	['email from the name column', { 0: 'property', 1: 'email', 2: 'property', 4: 'ignore' }],
	['blank-header property', { 0: 'email', 1: 'lastName', 3: 'property', 4: 'property' }],
	['only email', { 0: 'email' }],
	['no email', { 1: 'firstName', 2: 'language' }],
];

function load(mapping: ColumnMapping, data: string[][] = rows) {
	const csvImport = useCsvImport();
	csvImport.csvHeaders.value = headers;
	csvImport.parsedData.value = data;
	csvImport.columnMapping.value = mapping;
	return csvImport;
}

/** A row that counts every cell read, so a test can see which rows were prepared. */
function countingRow(cells: string[], reads: { count: number }): string[] {
	return new Proxy(cells, {
		get(target, key, receiver) {
			if (typeof key === 'string' && /^\d+$/.test(key)) reads.count++;
			return Reflect.get(target, key, receiver);
		},
	});
}

describe('useCsvImport parsed matrix', () => {
	beforeEach(() => {
		vi.stubGlobal('useI18n', () => ({ t }));
	});

	it('keeps the parsed matrix out of deep reactivity after a real file is read', async () => {
		const csvImport = useCsvImport();
		const file = new File(
			['Email,Name\nada@owlat.example,Ada\ngrace@owlat.example,Grace\n'],
			'c.csv',
			{
				type: 'text/csv',
			}
		);
		csvImport.handleFileSelect({ target: { files: [file] } } as unknown as Event);
		await vi.waitFor(() => expect(csvImport.step.value).toBe('mapping'));

		expect(csvImport.parsedData.value).toEqual([
			['ada@owlat.example', 'Ada'],
			['grace@owlat.example', 'Grace'],
		]);
		expect(isReactive(csvImport.parsedData.value)).toBe(false);
		expect(isProxy(csvImport.parsedData.value)).toBe(false);
		expect(isProxy(csvImport.parsedData.value[0])).toBe(false);
	});

	it.each(mappings)('previews the head of the full preparation (%s mapping)', (_label, mapping) => {
		const csvImport = load(mapping);
		const full = prepareCsvRows(rows, headers, mapping);

		expect(csvImport.previewRows.value).toEqual(full.slice(0, 5));
		expect(csvImport.preparedRows.value).toEqual(full);
	});

	it('follows a remap, an in-place mapping edit and a new file', () => {
		const csvImport = load(mappings[0]![1]);
		expect(csvImport.previewRows.value[0]!.contact.email).toBe('ada@owlat.example');

		csvImport.mapColumn(1, 'email');
		expect(csvImport.previewRows.value).toEqual(
			prepareCsvRows(rows, headers, csvImport.columnMapping.value).slice(0, 5)
		);
		expect(csvImport.previewRows.value[0]!.contact.email).toBe('Ada');

		// selectGlobalTopic rewrites a mapping entry in place.
		csvImport.mapColumn(0, 'email');
		csvImport.selectGlobalTopic('topic-1');
		expect(csvImport.columnMapping.value[4]).toBe('ignore');
		expect(csvImport.previewRows.value).toEqual(
			prepareCsvRows(rows, headers, csvImport.columnMapping.value).slice(0, 5)
		);

		const next = [['linus@owlat.example', 'Linus', '', '', '']];
		csvImport.parsedData.value = next;
		expect(csvImport.previewRows.value).toEqual(
			prepareCsvRows(next, headers, csvImport.columnMapping.value)
		);
		expect(csvImport.totalRowCount.value).toBe(1);
	});

	it('prepares only the preview rows on a mapping change, and every row for validation', () => {
		const reads = { count: 0 };
		const tracked = rows.map((cells, index) => (index < 5 ? cells : countingRow(cells, reads)));
		const csvImport = load(mappings[0]![1], tracked);

		expect(csvImport.previewRows.value).toHaveLength(5);
		csvImport.mapColumn(2, 'lastName');
		expect(csvImport.previewRows.value).toHaveLength(5);
		expect(reads.count).toBe(0);

		csvImport.goToPreviewFromListMapping();
		expect(reads.count).toBeGreaterThan(0);
	});

	it('validates and imports every row with the same normalization and errors', async () => {
		const mapping: ColumnMapping = { 0: 'email', 1: 'firstName', 2: 'property' };
		const csvImport = load(mapping);
		csvImport.step.value = 'mapping';
		const full = prepareCsvRows(rows, headers, mapping);

		csvImport.goToPreview();
		expect(csvImport.step.value).toBe('preview');
		expect(csvImport.validation.value).toEqual({
			validCount: full.filter((r) => r.status === 'valid').length,
			invalidEmails: [
				{ row: 3, email: 'not-an-email' },
				{ row: 8, email: 'bad@' },
			],
			duplicateEmails: [
				{ row: 2, email: 'ADA@owlat.example' },
				{ row: 6, email: 'grace@owlat.example' },
				{ row: 10, email: 'ada@OWLAT.example' },
			],
			missingEmails: [4, 9],
			totalRows: 10,
		});

		const importFn = vi.fn(async (contacts: ContactImport[]): Promise<ImportBatchOutcome> => ({
			ok: true,
			result: { imported: contacts.length, updated: 0, skipped: 0, failed: 0, errors: [] },
		}));
		await csvImport.startImport(importFn);

		const submitted = importFn.mock.calls.flatMap(([contacts]) => contacts);
		expect(submitted).toEqual(full.filter((r) => r.contact.email).map((r) => r.contact));
		expect(submitted[3]).toEqual({
			email: 'grace@owlat.example',
			firstName: 'Grace',
			properties: { Plan: 'team' },
		});
		expect(csvImport.results.value?.skipped).toBe(2);
	});
});
