import { describe, it, expect } from 'vitest';
import { isAutomatedMail, extractAntiLoopHeaders } from '../inboundClassification';

describe('isAutomatedMail', () => {
	it('treats ordinary mail as not automated', () => {
		expect(isAutomatedMail({})).toBe(false);
		expect(isAutomatedMail({ 'auto-submitted': 'no' })).toBe(false);
		expect(isAutomatedMail({ subject: 'hello', from: 'a@b.com' })).toBe(false);
		// Precedence: first-class is the explicit "this is a real, person-to-person
		// message" signal (RFC 3834 §5) — it must NOT be treated as bulk.
		expect(isAutomatedMail({ precedence: 'first-class' })).toBe(false);
	});

	it('flags Auto-Submitted other than "no"', () => {
		expect(isAutomatedMail({ 'auto-submitted': 'auto-replied' })).toBe(true);
		expect(isAutomatedMail({ 'auto-submitted': 'auto-generated' })).toBe(true);
		// case + surrounding whitespace tolerant
		expect(isAutomatedMail({ 'auto-submitted': '  Auto-Replied  ' })).toBe(true);
	});

	it('flags mailing-list and bulk signals', () => {
		expect(isAutomatedMail({ 'list-id': '<news.example.com>' })).toBe(true);
		expect(isAutomatedMail({ precedence: 'bulk' })).toBe(true);
		expect(isAutomatedMail({ precedence: 'list' })).toBe(true);
		expect(isAutomatedMail({ precedence: 'junk' })).toBe(true);
		// a non-bulk precedence is not a suppression signal
		expect(isAutomatedMail({ precedence: 'normal' })).toBe(false);
	});

	it('flags mail already touched by another Owlat mailbox', () => {
		expect(isAutomatedMail({ 'x-owlat-forwarded': 'a@owlat.app' })).toBe(true);
	});

	it('normalizes header-key casing (RFC 5322 field names are case-insensitive)', () => {
		expect(isAutomatedMail({ 'Auto-Submitted': 'auto-replied' })).toBe(true);
		expect(isAutomatedMail({ 'List-Id': '<x>' })).toBe(true);
		expect(isAutomatedMail({ Precedence: 'BULK' })).toBe(true);
	});
});

describe('extractAntiLoopHeaders', () => {
	const CRLF = '\r\n';

	it('pulls the anti-loop headers off a raw message and feeds isAutomatedMail', () => {
		const eml = [
			'From: list@example.com',
			'To: me@owlat.app',
			'Subject: Weekly digest',
			'List-Id: News <news.example.com>',
			'Precedence: bulk',
			'',
			'Body text mentioning List-Id: not-a-header here.',
		].join(CRLF);
		const h = extractAntiLoopHeaders(eml);
		expect(h['list-id']).toBe('News <news.example.com>');
		expect(h['precedence']).toBe('bulk');
		expect(isAutomatedMail(h)).toBe(true);
	});

	it('ignores header-looking lines in the body (stops at the blank line)', () => {
		const eml = ['From: a@b.com', 'Subject: hi', '', 'List-Id: <evil>'].join(CRLF);
		const h = extractAntiLoopHeaders(eml);
		expect(h['list-id']).toBeUndefined();
		expect(isAutomatedMail(h)).toBe(false);
	});

	it('unfolds folded header values', () => {
		const eml = ['List-Id: News', '\t<news.example.com>', '', 'body'].join(CRLF);
		expect(extractAntiLoopHeaders(eml)['list-id']).toBe('News <news.example.com>');
	});

	it('tolerates LF-only endings and returns only the relevant headers', () => {
		const eml = 'Auto-Submitted: auto-replied\nX-Other: keep-out\nFrom: x@y.com\n\nbody';
		const h = extractAntiLoopHeaders(eml);
		expect(h['auto-submitted']).toBe('auto-replied');
		expect(h['x-other']).toBeUndefined();
		expect(Object.keys(h)).toEqual(['auto-submitted']);
		expect(isAutomatedMail(h)).toBe(true);
	});

	it('returns an empty map for ordinary mail', () => {
		const eml = ['From: a@b.com', 'To: me@owlat.app', 'Subject: hello', '', 'hi'].join(CRLF);
		expect(extractAntiLoopHeaders(eml)).toEqual({});
	});
});
