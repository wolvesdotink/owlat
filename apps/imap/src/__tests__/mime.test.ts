import { describe, it, expect } from 'vitest';
import { parseAppendHeaders, buildSnippet } from '../mime.js';

function eml(lines: string[], body = 'Hello body'): Buffer {
	return Buffer.from(lines.join('\r\n') + '\r\n\r\n' + body);
}

describe('parseAppendHeaders', () => {
	it('extracts the standard envelope headers', () => {
		const parsed = parseAppendHeaders(
			eml([
				'Message-ID: <abc-123@mail.example>',
				'Subject: Quarterly report',
				'From: Jane Doe <jane@example.com>',
				'To: bob@example.com, carol@example.com',
				'Cc: dave@example.com',
				'Date: Tue, 09 Jun 2026 10:00:00 +0000',
			]),
		);
		expect(parsed.messageId).toBe('abc-123@mail.example');
		expect(parsed.subject).toBe('Quarterly report');
		expect(parsed.from).toMatchObject({ address: 'jane@example.com' });
		expect(parsed.to.map((a) => a.address)).toEqual(['bob@example.com', 'carol@example.com']);
		expect(parsed.cc.map((a) => a.address)).toEqual(['dave@example.com']);
		expect(parsed.internalDate).toBe(Date.parse('Tue, 09 Jun 2026 10:00:00 +0000'));
	});

	it('unfolds RFC 5322 continuation lines', () => {
		const parsed = parseAppendHeaders(
			eml(['Subject: part one', ' part two', 'From: a@b.com', 'To: c@d.com']),
		);
		expect(parsed.subject).toBe('part one part two');
	});

	it('decodes B- and Q-encoded MIME words in Subject', () => {
		const b64 = Buffer.from('Grüße aus Köln', 'utf-8').toString('base64');
		const b = parseAppendHeaders(eml([`Subject: =?utf-8?B?${b64}?=`, 'From: a@b.com', 'To: c@d.com']));
		expect(b.subject).toBe('Grüße aus Köln');

		const q = parseAppendHeaders(
			eml(['Subject: =?utf-8?Q?Caf=C3=A9_menu?=', 'From: a@b.com', 'To: c@d.com']),
		);
		expect(q.subject).toBe('Café menu');
	});

	it('generates a fallback Message-ID when none is present', () => {
		const parsed = parseAppendHeaders(eml(['Subject: x', 'From: a@b.com', 'To: c@d.com']));
		expect(parsed.messageId).toMatch(/^append-/);
	});

	it('tolerates LF-only line endings', () => {
		const raw = Buffer.from('Subject: lf only\nFrom: a@b.com\nTo: c@d.com\n\nbody');
		const parsed = parseAppendHeaders(raw);
		expect(parsed.subject).toBe('lf only');
		expect(parsed.from.address).toBe('a@b.com');
	});

	it('drops an unparseable Date instead of emitting NaN', () => {
		const parsed = parseAppendHeaders(
			eml(['Subject: x', 'From: a@b.com', 'To: c@d.com', 'Date: not a date']),
		);
		expect(parsed.internalDate).toBeUndefined();
	});

	it('falls back to a placeholder From when the header is missing', () => {
		const parsed = parseAppendHeaders(eml(['Subject: x', 'To: c@d.com']));
		expect(parsed.from.address).toBe('unknown@unknown');
	});
});

describe('buildSnippet', () => {
	it('strips tags, collapses whitespace, and caps at 200 chars', () => {
		const text = '<p>Hello   <b>world</b></p>\n\n' + 'x'.repeat(500);
		const snippet = buildSnippet(text);
		expect(snippet.startsWith('Hello world')).toBe(true);
		expect(snippet.length).toBeLessThanOrEqual(200);
	});

	it('returns empty string for undefined', () => {
		expect(buildSnippet(undefined)).toBe('');
	});
});
