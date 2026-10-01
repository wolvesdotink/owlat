import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestI18n } from '~/__tests__/i18n';
import { useBlocklistImport } from '../useBlocklistImport';

// The suppression import end to end through the real papaparse: a real `File`
// goes in, nothing is mocked between the file input and the preview step.
// One address per line is the format the upload step asks for, and before
// #910 every such file was rejected by papaparse's delimiter guess.
const i18n = createTestI18n();

async function selectFile(imp: ReturnType<typeof useBlocklistImport>, text: string, name: string) {
	const file = new File([text], name, { type: name.endsWith('.txt') ? 'text/plain' : 'text/csv' });
	await imp.handleFileSelect({ target: { files: [file], value: '' } } as unknown as Event);
}

const addresses = ['alice@example.com', 'bob@example.com', 'carol@example.com'];

describe('useBlocklistImport with the real papaparse', () => {
	beforeEach(() => {
		vi.stubGlobal('useI18n', () => i18n.global);
	});

	const cases: Array<[string, string]> = [];
	for (const name of ['blocklist.txt', 'blocklist.csv']) {
		for (const header of ['', 'email']) {
			for (const eol of ['\n', '\r\n']) {
				for (const trailing of [true, false]) {
					const lines = header ? [header, ...addresses] : addresses;
					const text = lines.join(eol) + (trailing ? eol : '');
					const label = [
						name,
						header ? 'with header' : 'no header',
						eol === '\n' ? 'LF' : 'CRLF',
						trailing ? 'trailing newline' : 'no trailing newline',
					].join(', ');
					cases.push([label, text]);
				}
			}
		}
	}

	it.each(cases)('takes a one-address-per-line file to preview (%s)', async (label, text) => {
		const imp = useBlocklistImport();
		await selectFile(imp, text, label.split(',')[0]!);

		expect(imp.error.value).toBe('');
		expect(imp.step.value).toBe('preview');
		expect(imp.validation.value).toEqual({ valid: addresses, invalid: [], duplicates: 0 });
	});

	it('still takes the first column of a short multi-column CSV', async () => {
		const imp = useBlocklistImport();
		await selectFile(
			imp,
			'email;reason\nalice@example.com;bounced\nbob@example.com;manual\n',
			'list.csv'
		);

		expect(imp.step.value).toBe('preview');
		expect(imp.validation.value!.valid).toEqual(['alice@example.com', 'bob@example.com']);
	});

	it('shows a parse error for an unterminated quote', async () => {
		const imp = useBlocklistImport();
		await selectFile(imp, 'alice@example.com\n"bob@example.com\ncarol@example.com\n', 'list.txt');

		expect(imp.step.value).toBe('upload');
		expect(imp.error.value).toMatch(/^File parsing error: .*quote/i);
	});
});
