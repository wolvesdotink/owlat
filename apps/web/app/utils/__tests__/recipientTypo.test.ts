/**
 * Did-you-mean for a recipient domain (utils/recipientTypo) and the
 * never-emailed-before set (utils/recipientHints → firstTimeRecipients).
 */
import { describe, it, expect } from 'vitest';
import { COMMON_MAIL_DOMAINS, suggestRecipientDomain } from '../recipientTypo';
import { firstTimeRecipients } from '../recipientHints';

describe('suggestRecipientDomain', () => {
	it('catches the classic provider typos', () => {
		expect(suggestRecipientDomain('anna@gmial.com')).toEqual({
			mistyped: 'anna@gmial.com',
			typed: 'gmial.com',
			suggested: 'gmail.com',
			address: 'anna@gmail.com',
		});
		expect(suggestRecipientDomain('x@hotmial.com')?.suggested).toBe('hotmail.com');
		expect(suggestRecipientDomain('x@outlok.com')?.suggested).toBe('outlook.com');
	});

	it('is silent on a domain that is already correct', () => {
		expect(suggestRecipientDomain('anna@gmail.com')).toBeNull();
		expect(suggestRecipientDomain('ines@northwind.studio', ['northwind.studio'])).toBeNull();
	});

	it('prefers a domain the user actually writes to over a global provider', () => {
		expect(suggestRecipientDomain('ines@northwind.studi', ['northwind.studio'])).toEqual({
			mistyped: 'ines@northwind.studi',
			typed: 'northwind.studi',
			suggested: 'northwind.studio',
			address: 'ines@northwind.studio',
		});
	});

	it('keeps the local part exactly as typed, and canonicalizes the framing', () => {
		expect(suggestRecipientDomain('"Anna B" <Anna.B@GMIAL.com>')?.address).toBe('anna.b@gmail.com');
	});

	it('stays quiet on a domain that is nowhere near a candidate', () => {
		expect(suggestRecipientDomain('ada@acme-corp.io')).toBeNull();
		expect(suggestRecipientDomain('ada@northwind.studio')).toBeNull();
	});

	it('tightens the bound on short domains, where two edits is a different domain', () => {
		// web.de / gmx.de are both real and 3 edits apart; one slip still counts.
		expect(suggestRecipientDomain('x@web.de')).toBeNull();
		expect(suggestRecipientDomain('x@gmx.de')).toBeNull();
		expect(suggestRecipientDomain('x@web.dee')?.suggested).toBe('web.de');
		expect(suggestRecipientDomain('x@zoho.co')?.suggested).toBe('zoho.com');
	});

	it('returns null for anything that is not a usable address', () => {
		expect(suggestRecipientDomain('')).toBeNull();
		expect(suggestRecipientDomain('no-at-sign')).toBeNull();
		expect(suggestRecipientDomain('ada@localhost')).toBeNull();
		expect(suggestRecipientDomain('@gmial.com')).toBeNull();
	});

	it('ignores blank or dotless entries in the known-domain list', () => {
		expect(suggestRecipientDomain('anna@gmial.com', ['', '  ', 'localhost'])?.suggested).toBe(
			'gmail.com'
		);
	});

	it('keeps the provider list free of duplicates and of dotless entries', () => {
		expect(new Set(COMMON_MAIL_DOMAINS).size).toBe(COMMON_MAIL_DOMAINS.length);
		expect(COMMON_MAIL_DOMAINS.every((d) => d.includes('.') && d === d.toLowerCase())).toBe(true);
	});
});

describe('firstTimeRecipients', () => {
	it('returns only the addresses the mailbox has never written to', () => {
		expect(
			firstTimeRecipients(
				['ines@northwind.studio', 'j.weber@acme-corp.io'],
				['ines@northwind.studio']
			)
		).toEqual(['j.weber@acme-corp.io']);
	});

	it('matches a known contact through display framing and case', () => {
		expect(
			firstTimeRecipients(['"Ines" <INES@northwind.studio>'], ['ines@northwind.studio'])
		).toEqual([]);
	});

	it('preserves order, keeps the raw string, and dedupes', () => {
		expect(firstTimeRecipients(['b@x.test', 'a@x.test', '"A" <a@x.test>'], [])).toEqual([
			'b@x.test',
			'a@x.test',
		]);
	});

	it('is empty for an empty recipient list', () => {
		expect(firstTimeRecipients([], ['a@x.test'])).toEqual([]);
	});
});
