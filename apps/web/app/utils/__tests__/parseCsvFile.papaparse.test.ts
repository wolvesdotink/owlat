import { describe, it, expect } from 'vitest';
import { parseCsvFile } from '../contactsCsv';

/**
 * `parseCsvFile` against the real papaparse and a real `File`.
 *
 * The sibling `parseCsvFile.test.ts` mocks papaparse to pin the callback
 * plumbing, which is exactly why it never saw papaparse's delimiter guess fail
 * on single-column files and on short files that end with a newline (#910).
 * Nothing is mocked here.
 */
const csv = (text: string, name = 'test.csv') => new File([text], name, { type: 'text/csv' });

const emails = ['user1@example.com', 'user2@example.com', 'user3@example.com'];

describe('parseCsvFile (real papaparse)', () => {
	describe('single-column files', () => {
		it.each([
			['with a header and a trailing newline', `Email\n${emails.join('\n')}\n`],
			['with a header and no trailing newline', `Email\n${emails.join('\n')}`],
			['with CRLF line endings', `Email\r\n${emails.join('\r\n')}\r\n`],
		])('parses one cell per row %s', async (_label, text) => {
			await expect(parseCsvFile(csv(text))).resolves.toEqual([
				['Email'],
				...emails.map((e) => [e]),
			]);
		});

		it('parses a headerless one-address-per-line .txt file', async () => {
			await expect(parseCsvFile(csv(`${emails.join('\n')}\n`, 'list.txt'))).resolves.toEqual(
				emails.map((e) => [e])
			);
		});

		it('parses a long single-column file (past the 10-line delimiter sample)', async () => {
			const rows = Array.from({ length: 500 }, (_, i) => `user${i}@example.com`);
			const parsed = await parseCsvFile(csv(`Email\r\n${rows.join('\r\n')}\r\n`));
			expect(parsed).toHaveLength(501);
			expect(parsed[0]).toEqual(['Email']);
			expect(parsed[500]).toEqual(['user499@example.com']);
			expect(parsed.every((row) => row.length === 1)).toBe(true);
		});
	});

	describe('short two-column files with a trailing newline', () => {
		it.each([
			['comma', ','],
			['semicolon', ';'],
			['tab', '\t'],
		])('detects the %s delimiter', async (_label, d) => {
			const text = `Email${d}Name\nuser1@example.com${d}Alice\nuser2@example.com${d}Bob\n`;
			await expect(parseCsvFile(csv(text))).resolves.toEqual([
				['Email', 'Name'],
				['user1@example.com', 'Alice'],
				['user2@example.com', 'Bob'],
			]);
		});

		it('detects the delimiter with CRLF line endings', async () => {
			const text = 'Email;Name\r\nuser1@example.com;Alice\r\nuser2@example.com;Bob\r\n';
			await expect(parseCsvFile(csv(text))).resolves.toEqual([
				['Email', 'Name'],
				['user1@example.com', 'Alice'],
				['user2@example.com', 'Bob'],
			]);
		});
	});

	it('drops blank lines in the middle of a file', async () => {
		const text = `Email\n${emails[0]}\n\n   \n${emails[1]}\n`;
		await expect(parseCsvFile(csv(text))).resolves.toEqual([['Email'], [emails[0]], [emails[1]]]);
	});

	it('resolves an empty file with no rows', async () => {
		await expect(parseCsvFile(csv(''))).resolves.toEqual([]);
	});

	it.each([
		['a single-column file', `Email\n"${emails[0]}\n${emails[1]}\n`],
		['a two-column file', `Email,Name\n"${emails[0]},Alice\n${emails[1]},Bob\n`],
	])('still rejects an unterminated quote in %s', async (_label, text) => {
		await expect(parseCsvFile(csv(text))).rejects.toThrow(/quote/i);
	});
});
