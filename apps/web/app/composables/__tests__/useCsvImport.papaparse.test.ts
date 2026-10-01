import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestI18n } from '~/__tests__/i18n';
import { useCsvImport } from '../useCsvImport';

// The contacts import end to end through the real papaparse: a real `File`
// goes in, nothing is mocked between the file input and the mapping step.
// `useCsvImport.test.ts` mocks papaparse, which is how #910 (every
// single-column file rejected before mapping) went unnoticed.
const { t } = createTestI18n().global;

function selectFile(
	csvImport: ReturnType<typeof useCsvImport>,
	text: string,
	name = 'contacts.csv'
) {
	const file = new File([text], name, { type: 'text/csv' });
	csvImport.handleFileSelect({ target: { files: [file] } } as unknown as Event);
}

describe('useCsvImport with the real papaparse', () => {
	beforeEach(() => {
		vi.stubGlobal('useI18n', () => ({ t }));
	});

	it.each([
		['LF with a trailing newline', 'Email\nuser1@example.com\nuser2@example.com\n'],
		['LF without a trailing newline', 'Email\nuser1@example.com\nuser2@example.com'],
		['CRLF', 'Email\r\nuser1@example.com\r\nuser2@example.com\r\n'],
	])(
		'takes an Email-only file (%s) to the mapping step with Email auto-mapped',
		async (_label, text) => {
			const csvImport = useCsvImport();
			selectFile(csvImport, text);

			await vi.waitFor(() => expect(csvImport.step.value).toBe('mapping'));
			expect(csvImport.error.value).toBe('');
			expect(csvImport.csvHeaders.value).toEqual(['Email']);
			expect(csvImport.parsedData.value).toEqual([['user1@example.com'], ['user2@example.com']]);
			expect(csvImport.columnMapping.value).toEqual({ 0: 'email' });
			expect(csvImport.isEmailMapped.value).toBe(true);
		}
	);

	it.each([
		['comma', ','],
		['semicolon', ';'],
		['tab', '\t'],
	])('splits a short %s-delimited file with a trailing newline into columns', async (_label, d) => {
		const csvImport = useCsvImport();
		selectFile(csvImport, `Email${d}First Name\nuser1@example.com${d}Alice\n`);

		await vi.waitFor(() => expect(csvImport.step.value).toBe('mapping'));
		expect(csvImport.csvHeaders.value).toEqual(['Email', 'First Name']);
		expect(csvImport.parsedData.value).toEqual([['user1@example.com', 'Alice']]);
		expect(csvImport.columnMapping.value).toEqual({ 0: 'email', 1: 'firstName' });
	});

	it('shows a parse error and stays on upload for an unterminated quote', async () => {
		const csvImport = useCsvImport();
		selectFile(csvImport, 'Email\n"user1@example.com\nuser2@example.com\n');

		await vi.waitFor(() => expect(csvImport.error.value).toMatch(/^CSV parsing error: .*quote/i));
		expect(csvImport.step.value).toBe('upload');
	});

	it('reports a header-only file as too few rows instead of a parse error', async () => {
		const csvImport = useCsvImport();
		selectFile(csvImport, 'Email\n');

		await vi.waitFor(() =>
			expect(csvImport.error.value).toBe(t('shared.useCsvImport.errors.tooFewRows'))
		);
		expect(csvImport.step.value).toBe('upload');
	});
});
