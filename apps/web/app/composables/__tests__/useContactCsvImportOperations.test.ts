/**
 * The contacts page's import callbacks against the real `useCsvImport` (#897).
 *
 * The page used to turn a failed `importBatch` into an all-zero success, and
 * ignored the property registration's result. The composable's own suite covers
 * what it does with a failure it is TOLD about; this one covers the boundary
 * that dropped it: the operation module's `{ ok: false }` has to reach the
 * import loop as a failure, with a reason, while the module's own failure
 * treatment (toast, redirect, telemetry) still runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OperationError } from '@owlat/shared/operationError';

vi.mock('papaparse', () => ({ default: { parse: vi.fn() } }));
vi.mock('@owlat/api', () => ({
	api: {
		contacts: {
			contacts: { importBatch: 'contacts.importBatch' },
			properties: { create: 'contacts.properties.create' },
		},
	},
}));

import Papa from 'papaparse';
import { createTestI18n } from '~/__tests__/i18n';
import { useCsvImport } from '../useCsvImport';
import { useContactCsvImportOperations } from '../useContactCsvImportOperations';

const i18n = createTestI18n();
const { t } = i18n.global;

interface FakeRun {
	calls: Array<Record<string, unknown>>;
	/** 1-based run numbers that fail, and with what. */
	failures: Map<number, OperationError>;
	/** What `onError` answered for each failure — `false` keeps the module's toast. */
	claimed: boolean[];
}

let runs: Record<string, FakeRun>;

/**
 * `useBackendOperation` as the page sees it: `run` resolves the envelope and
 * never throws, and a failure goes through `onError` before the module applies
 * its own treatment.
 */
function fakeBackendOperation(
	operation: string,
	opts: { onError?: (op: OperationError) => boolean }
) {
	const fake: FakeRun = (runs[operation] ??= { calls: [], failures: new Map(), claimed: [] });
	return {
		run: async (args: Record<string, unknown>) => {
			fake.calls.push(args);
			const failure = fake.failures.get(fake.calls.length);
			if (failure) {
				fake.claimed.push(opts.onError?.(failure) ?? false);
				return { ok: false };
			}
			const contacts = (args['contacts'] as unknown[] | undefined) ?? [];
			return {
				ok: true,
				result: {
					imported: contacts.length,
					updated: 0,
					skipped: 0,
					failed: 0,
					errors: [],
					addedToList: 0,
				},
			};
		},
	};
}

function failRun(operation: string, runNumber: number, error: OperationError) {
	(runs[operation] ??= { calls: [], failures: new Map(), claimed: [] }).failures.set(
		runNumber,
		error
	);
}

async function loadCsv(
	csvImport: ReturnType<typeof useCsvImport>,
	headers: string[],
	rows: string[][]
) {
	(Papa.parse as unknown as ReturnType<typeof vi.fn>).mockImplementation(
		(_file: unknown, options: { complete: (r: { data: string[][]; errors: [] }) => void }) =>
			options.complete({ data: [headers, ...rows], errors: [] })
	);
	const file = new File([''], 'people.csv', { type: 'text/csv' });
	await csvImport.handleFileSelect({ target: { files: [file] } } as unknown as Event);
}

const rows201 = Array.from({ length: 201 }, (_, i) => [`user${i + 1}@example.com`]);

beforeEach(() => {
	vi.clearAllMocks();
	runs = {};
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('useBackendOperation', fakeBackendOperation);
});

describe('contacts page CSV import → useCsvImport', () => {
	it('carries a failed batch into the accounting instead of an all-zero success', async () => {
		const csvImport = useCsvImport();
		const ops = useContactCsvImportOperations(() => []);
		await loadCsv(csvImport, ['Email'], rows201);
		failRun('contacts.importBatch', 2, {
			category: 'rate_limited',
			message: 'Too many imports, try again in a minute',
		});

		await csvImport.startImport(ops.importBatch, ops.registerProperties);

		expect(runs['contacts.importBatch']!.calls).toHaveLength(2);
		expect(csvImport.results.value!.imported).toBe(100);
		expect(csvImport.failedBatch.value).toEqual({
			size: 100,
			reason: 'Too many imports, try again in a minute',
		});
		const failedRows = csvImport.notImportedRows.value.filter((r) => r.attempted);
		expect(failedRows[0]).toEqual({ row: 101, email: 'user101@example.com', attempted: true });
		expect(failedRows.at(-1)!.row).toBe(200);
		expect(csvImport.notImportedRowCount.value).toBe(101);
		// The module's toast/telemetry still apply; the page only listened.
		expect(runs['contacts.importBatch']!.claimed).toEqual([false]);
	});

	it('uses the generic copy as the reason for an internal fault', async () => {
		const csvImport = useCsvImport();
		const ops = useContactCsvImportOperations(() => []);
		await loadCsv(csvImport, ['Email'], rows201);
		failRun('contacts.importBatch', 1, {
			category: 'internal',
			message: '[CONVEX M(contacts/contacts:importBatch)] Server Error',
		});

		await csvImport.startImport(ops.importBatch, ops.registerProperties);

		expect(csvImport.failedBatch.value!.reason).toBe(t('shared.operationError.generic'));
		expect(csvImport.notImportedRowCount.value).toBe(201);
	});

	it('retries through the same callback without replaying committed batches', async () => {
		const csvImport = useCsvImport();
		const ops = useContactCsvImportOperations(() => []);
		await loadCsv(csvImport, ['Email'], rows201);
		failRun('contacts.importBatch', 2, { category: 'network', message: 'Failed to fetch' });
		await csvImport.startImport(ops.importBatch, ops.registerProperties);

		await csvImport.retryFailedRows(ops.importBatch);

		const calls = runs['contacts.importBatch']!.calls;
		// Batch 1, the failed batch 2, then the retry: rows 101–200 and row 201.
		expect(calls).toHaveLength(4);
		const retried = calls
			.slice(2)
			.flatMap((call) => (call['contacts'] as Array<{ email: string }>).map((c) => c.email));
		expect(retried).toHaveLength(101);
		expect(retried[0]).toBe('user101@example.com');
		expect(retried).not.toContain('user1@example.com');
		expect(csvImport.results.value!.imported).toBe(201);
		expect(csvImport.notImportedRowCount.value).toBe(0);
	});

	it('stops before importing when a property cannot be registered', async () => {
		const csvImport = useCsvImport();
		const ops = useContactCsvImportOperations(() => ['Plan']);
		await loadCsv(
			csvImport,
			['Email', 'Company', 'Plan', 'Region'],
			[['ada@example.com', 'Acme', 'pro', 'EU']]
		);
		csvImport.columnMapping.value = { 0: 'email', 1: 'property', 2: 'property', 3: 'property' };
		csvImport.goToPreview();
		failRun('contacts.properties.create', 1, {
			category: 'limit_reached',
			message: 'This workspace has reached its custom property limit',
		});

		await csvImport.startImport(ops.importBatch, ops.registerProperties);

		// `Plan` already exists; `Company` failed, so `Region` was never tried.
		expect(runs['contacts.properties.create']!.calls).toEqual([
			{ key: 'Company', label: 'Company', type: 'string' },
		]);
		expect(runs['contacts.importBatch']!.calls).toHaveLength(0);
		expect(csvImport.step.value).toBe('preview');
		expect(csvImport.error.value).toContain('This workspace has reached its custom property limit');
		expect(csvImport.columnMapping.value).toEqual({
			0: 'email',
			1: 'property',
			2: 'property',
			3: 'property',
		});
	});

	it('registers every missing key, then imports', async () => {
		const csvImport = useCsvImport();
		const ops = useContactCsvImportOperations(() => []);
		await loadCsv(csvImport, ['Email', 'Company'], [['ada@example.com', 'Acme']]);
		csvImport.columnMapping.value = { 0: 'email', 1: 'property' };

		await csvImport.startImport(ops.importBatch, ops.registerProperties);

		expect(runs['contacts.properties.create']!.calls).toHaveLength(1);
		expect(runs['contacts.importBatch']!.calls[0]!['contacts']).toEqual([
			{ email: 'ada@example.com', properties: { Company: 'Acme' } },
		]);
		expect(csvImport.step.value).toBe('complete');
		expect(csvImport.notImportedRowCount.value).toBe(0);
	});
});
