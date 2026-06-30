import { describe, it, expect } from 'vitest';
import { extractText, stripHtmlTags, truncateForLLM } from '../semanticFileProcessing';

/**
 * Unit coverage for the semantic-file text-extraction dispatch — the documented
 * matrix of which formats produce real extracted text vs a filename-only
 * placeholder, plus the HTML sanitisation that protects the LLM/knowledge-graph
 * ingestion path from smuggled markup/scripts.
 *
 * (The embedding + vector-search halves of the pipeline call an LLM provider and
 * ctx.vectorSearch, neither of which is reproducible under convex-test; the
 * contact-scope post-filter is covered in lib/__tests__/contactScope.test.ts.)
 */

const blob = (text: string, type = 'text/plain') => new Blob([text], { type });

describe('extractText — real-text formats', () => {
	it('returns the raw text for text/* and application/json', async () => {
		expect(await extractText(blob('hello world'), 'text/plain', 'a.txt')).toBe('hello world');
		expect(await extractText(blob('{"a":1}', 'application/json'), 'application/json', 'a.json')).toBe('{"a":1}');
	});

	it('strips tags for text/html', async () => {
		const out = await extractText(blob('<p>Hi <b>there</b></p>', 'text/html'), 'text/html', 'a.html');
		expect(out).toBe('Hi there');
	});

	it('reads CSV by mime or by .csv extension', async () => {
		expect(await extractText(blob('a,b\n1,2', 'text/csv'), 'text/csv', 'd.csv')).toBe('a,b\n1,2');
		// Octet-stream upload but .csv filename still extracts.
		expect(await extractText(blob('x,y', 'application/octet-stream'), 'application/octet-stream', 'd.csv')).toBe('x,y');
	});
});

describe('extractText — filename-only placeholders', () => {
	it('returns a placeholder for Word/Excel/image/unknown binaries', async () => {
		const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
		const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
		expect(await extractText(blob('', docx), docx, 'report.docx')).toBe('[Word document: report.docx]');
		expect(await extractText(blob('', xlsx), xlsx, 'sheet.xlsx')).toBe('[Spreadsheet: sheet.xlsx]');
		expect(await extractText(blob('', 'image/png'), 'image/png', 'logo.png')).toBe('[Image: logo.png]');
		expect(await extractText(blob('', 'application/zip'), 'application/zip', 'x.bin')).toBe('[File: x.bin]');
	});
});

describe('stripHtmlTags', () => {
	it('removes script and style bodies, not just tags', async () => {
		const html = '<style>.x{color:red}</style><p>Visible</p><script>steal()</script>';
		const out = stripHtmlTags(html);
		expect(out).toBe('Visible');
		expect(out).not.toContain('steal');
		expect(out).not.toContain('color:red');
	});

	it('collapses whitespace left by removed tags', () => {
		expect(stripHtmlTags('<div>  a  </div>\n<div>b</div>')).toBe('a b');
	});
});

describe('truncateForLLM', () => {
	it('returns the text unchanged when within the limit', () => {
		expect(truncateForLLM('short', 100)).toBe('short');
	});

	it('truncates and appends the marker when over the limit', () => {
		const out = truncateForLLM('abcdefghij', 5);
		expect(out.startsWith('abcde')).toBe(true);
		expect(out).toContain('[Content truncated...]');
	});
});
