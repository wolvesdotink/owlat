import { describe, it, expect } from 'vitest';
import {
	parseListUnsubscribe,
	extractListUnsubscribe,
	isSafeUnsubscribeUrl,
} from '../listUnsubscribe';

describe('parseListUnsubscribe', () => {
	it('parses a One-Click https target (RFC 8058)', () => {
		expect(
			parseListUnsubscribe(
				'<https://news.example.com/unsub?u=abc123>',
				'List-Unsubscribe=One-Click',
			),
		).toEqual({
			httpUrl: 'https://news.example.com/unsub?u=abc123',
			mailtoUrl: undefined,
			oneClick: true,
		});
	});

	it('parses a mailto-only header', () => {
		expect(parseListUnsubscribe('<mailto:unsub@list.example.com?subject=stop>')).toEqual({
			httpUrl: undefined,
			mailtoUrl: 'mailto:unsub@list.example.com?subject=stop',
			oneClick: false,
		});
	});

	it('parses both URIs, first of each scheme wins', () => {
		expect(
			parseListUnsubscribe(
				'<mailto:unsub@list.example.com>, <https://a.example.com/u>, <https://b.example.com/u>',
			),
		).toEqual({
			httpUrl: 'https://a.example.com/u',
			mailtoUrl: 'mailto:unsub@list.example.com',
			oneClick: false,
		});
	});

	it('is not One-Click without the Post header', () => {
		const t = parseListUnsubscribe('<https://news.example.com/unsub>');
		expect(t?.oneClick).toBe(false);
	});

	it('is not One-Click for a mailto-only header even with the Post header', () => {
		const t = parseListUnsubscribe(
			'<mailto:unsub@list.example.com>',
			'List-Unsubscribe=One-Click',
		);
		expect(t?.oneClick).toBe(false);
	});

	it('accepts case-insensitive schemes and Post value', () => {
		const t = parseListUnsubscribe('<HTTPS://News.Example.com/U>', 'list-unsubscribe=ONE-CLICK');
		expect(t).toEqual({
			httpUrl: 'HTTPS://News.Example.com/U',
			mailtoUrl: undefined,
			oneClick: true,
		});
	});

	it('ignores http:// URIs entirely', () => {
		expect(parseListUnsubscribe('<http://insecure.example.com/unsub>')).toBeNull();
	});

	it('returns null for malformed / empty headers', () => {
		expect(parseListUnsubscribe(undefined)).toBeNull();
		expect(parseListUnsubscribe(null)).toBeNull();
		expect(parseListUnsubscribe('')).toBeNull();
		expect(parseListUnsubscribe('no angle brackets here')).toBeNull();
		expect(parseListUnsubscribe('<>')).toBeNull();
		expect(parseListUnsubscribe('<ftp://example.com/x>')).toBeNull();
	});
});

describe('extractListUnsubscribe', () => {
	const eml = (headers: string) => `${headers}\r\n\r\nBody text here\r\n`;

	it('extracts + parses from a raw header block', () => {
		const raw = eml(
			'From: news@example.com\r\n' +
				'Subject: Weekly digest\r\n' +
				'List-Unsubscribe: <mailto:unsub@example.com>, <https://example.com/unsub?u=1>\r\n' +
				'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
		);
		expect(extractListUnsubscribe(raw)).toEqual({
			httpUrl: 'https://example.com/unsub?u=1',
			mailtoUrl: 'mailto:unsub@example.com',
			oneClick: true,
		});
	});

	it('unfolds folded header values', () => {
		const raw = eml(
			'Subject: x\r\n' +
				'List-Unsubscribe: <mailto:unsub@example.com>,\r\n <https://example.com/unsub>',
		);
		expect(extractListUnsubscribe(raw)).toEqual({
			httpUrl: 'https://example.com/unsub',
			mailtoUrl: 'mailto:unsub@example.com',
			oneClick: false,
		});
	});

	it('ignores a List-Unsubscribe line in the body', () => {
		const raw =
			'From: a@example.com\r\nSubject: x\r\n\r\n' +
			'List-Unsubscribe: <https://evil.example.com/unsub>\r\n';
		expect(extractListUnsubscribe(raw)).toBeNull();
	});

	it('returns null when the header is absent', () => {
		expect(extractListUnsubscribe(eml('From: a@example.com\r\nSubject: x'))).toBeNull();
	});
});

describe('isSafeUnsubscribeUrl', () => {
	it('accepts a normal public https URL', () => {
		expect(isSafeUnsubscribeUrl('https://news.example.com/unsub?u=abc')).toBe(true);
		expect(isSafeUnsubscribeUrl('https://example.co.uk:8443/u')).toBe(true);
	});

	it('rejects http', () => {
		expect(isSafeUnsubscribeUrl('http://news.example.com/unsub')).toBe(false);
	});

	it('rejects non-URLs and other schemes', () => {
		expect(isSafeUnsubscribeUrl('not a url')).toBe(false);
		expect(isSafeUnsubscribeUrl('mailto:unsub@example.com')).toBe(false);
		expect(isSafeUnsubscribeUrl('file:///etc/passwd')).toBe(false);
	});

	it('rejects private / loopback IPv4 literals', () => {
		expect(isSafeUnsubscribeUrl('https://127.0.0.1/unsub')).toBe(false);
		expect(isSafeUnsubscribeUrl('https://10.1.2.3/unsub')).toBe(false);
		expect(isSafeUnsubscribeUrl('https://192.168.0.10/unsub')).toBe(false);
		expect(isSafeUnsubscribeUrl('https://172.16.5.4/unsub')).toBe(false);
		expect(isSafeUnsubscribeUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
	});

	it('rejects ANY IP literal, even public ones', () => {
		expect(isSafeUnsubscribeUrl('https://8.8.8.8/unsub')).toBe(false);
		expect(isSafeUnsubscribeUrl('https://[::1]/unsub')).toBe(false);
		expect(isSafeUnsubscribeUrl('https://[2001:db8::1]/unsub')).toBe(false);
	});

	it('rejects localhost / internal names and single-label hosts', () => {
		expect(isSafeUnsubscribeUrl('https://localhost/unsub')).toBe(false);
		expect(isSafeUnsubscribeUrl('https://foo.localhost/unsub')).toBe(false);
		expect(isSafeUnsubscribeUrl('https://printer.local/unsub')).toBe(false);
		expect(isSafeUnsubscribeUrl('https://db.internal/unsub')).toBe(false);
		expect(isSafeUnsubscribeUrl('https://intranet/unsub')).toBe(false);
	});

	it('rejects embedded credentials', () => {
		expect(isSafeUnsubscribeUrl('https://user:pass@example.com/unsub')).toBe(false);
		expect(isSafeUnsubscribeUrl('https://user@example.com/unsub')).toBe(false);
	});
});
