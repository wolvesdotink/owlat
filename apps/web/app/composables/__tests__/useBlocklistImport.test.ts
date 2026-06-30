import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('papaparse', () => ({
	default: {
		parse: vi.fn(),
	},
}));

import Papa from 'papaparse';
import { useBlocklistImport } from '../useBlocklistImport';

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
 * Simulate selecting a file that Papa parses into the given rows.
 */
async function simulateFileSelect(
	blocklistImport: ReturnType<typeof useBlocklistImport>,
	rows: string[][],
	fileName = 'blocklist.csv'
) {
	const mockParse = Papa.parse as unknown as PapaMock;
	mockParse.mockImplementation((_file, options) => {
		options.complete({ data: rows, errors: [] });
	});

	const fakeFile = new File([''], fileName, { type: 'text/csv' });
	const fakeEvent = { target: { files: [fakeFile], value: '' } } as unknown as Event;
	await blocklistImport.handleFileSelect(fakeEvent);
}

describe('useBlocklistImport', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('starts on the upload step with no validation/results', async () => {
		const imp = useBlocklistImport();
		expect(imp.step.value).toBe('upload');
		expect(imp.isOpen.value).toBe(false);
		expect(imp.error.value).toBe('');
		expect(imp.validation.value).toBeNull();
		expect(imp.results.value).toBeNull();
		expect(imp.canImport.value).toBe(false);
	});

	it('rejects an unsupported file extension', async () => {
		const imp = useBlocklistImport();
		await simulateFileSelect(imp, [['a@b.com']], 'list.json');
		expect(imp.error.value).toContain('.csv or .txt');
		expect(imp.step.value).toBe('upload');
	});

	it('parses, validates and dedupes addresses, then advances to preview', async () => {
		const imp = useBlocklistImport();
		await simulateFileSelect(imp, [
			['email'], // header row — ignored
			['Alice@Example.com'],
			['bob@example.com'],
			['alice@example.com'], // duplicate of the first (case-insensitive)
			['not-an-email'],
			['carol@example.com', 'manual', 'a note'], // first column is the email
		]);

		expect(imp.step.value).toBe('preview');
		expect(imp.validation.value).not.toBeNull();
		// Normalized + deduped
		expect(imp.validation.value!.valid).toEqual([
			'alice@example.com',
			'bob@example.com',
			'carol@example.com',
		]);
		expect(imp.validation.value!.duplicates).toBe(1);
		expect(imp.validation.value!.invalid).toEqual(['not-an-email']);
		expect(imp.validCount.value).toBe(3);
		expect(imp.canImport.value).toBe(true);
	});

	it('surfaces an error when no valid address is found', async () => {
		const imp = useBlocklistImport();
		await simulateFileSelect(imp, [['email'], ['nope'], ['also-bad']]);
		expect(imp.step.value).toBe('upload');
		expect(imp.error.value).toContain('No valid email addresses');
	});

	it('rejects a file with too many rows', async () => {
		const imp = useBlocklistImport();
		const rows = Array.from({ length: 1001 }, (_, i) => [`user${i}@example.com`]);
		await simulateFileSelect(imp, rows);
		expect(imp.step.value).toBe('upload');
		expect(imp.error.value).toContain('Too many rows');
	});

	it('sends manual-reason payloads to bulkAdd and records results on success', async () => {
		const imp = useBlocklistImport();
		await simulateFileSelect(imp, [['a@example.com'], ['b@example.com']]);

		const bulkAdd = vi.fn().mockResolvedValue({ added: 2, skipped: 0, errors: [] });
		const res = await imp.startImport(bulkAdd);

		expect(bulkAdd).toHaveBeenCalledWith([
			{ email: 'a@example.com', reason: 'manual' },
			{ email: 'b@example.com', reason: 'manual' },
		]);
		expect(res).toEqual({ added: 2, skipped: 0, errors: [] });
		expect(imp.step.value).toBe('complete');
		expect(imp.results.value).toEqual({ added: 2, skipped: 0, errors: [] });
	});

	it('returns to preview when the import operation fails (undefined)', async () => {
		const imp = useBlocklistImport();
		await simulateFileSelect(imp, [['a@example.com']]);

		const bulkAdd = vi.fn().mockResolvedValue(undefined);
		const res = await imp.startImport(bulkAdd);

		expect(res).toBeUndefined();
		expect(imp.step.value).toBe('preview');
		expect(imp.results.value).toBeNull();
	});

	it('resets state on open', async () => {
		const imp = useBlocklistImport();
		await simulateFileSelect(imp, [['a@example.com']]);
		expect(imp.step.value).toBe('preview');

		imp.open();
		expect(imp.isOpen.value).toBe(true);
		expect(imp.step.value).toBe('upload');
		expect(imp.validation.value).toBeNull();
		expect(imp.error.value).toBe('');
	});
});
