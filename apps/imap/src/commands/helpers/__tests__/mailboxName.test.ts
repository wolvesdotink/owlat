import { describe, it, expect } from 'vitest';
import type { ImapFlow } from 'imapflow';
import { decodePath, encodePath } from 'imapflow/lib/tools.js';
import {
	decodeMailboxName,
	encodeMailboxName,
	imapMailboxName,
	mailboxNameFromClient,
} from '../mailboxName.js';

/** An IMAP4rev1 session without UTF8=ACCEPT, as ImapFlow sees this server. */
const REV1 = { enabled: new Set(), capabilities: new Set(['IMAP4rev1']) } as unknown as ImapFlow;

describe('encodeMailboxName (RFC 3501 §5.1.3)', () => {
	it.each([
		['&', '&-'],
		['R&D', 'R&-D'],
		['Übersicht', '&ANw-bersicht'],
		['📁 Mail', '&2D3cwQ- Mail'],
		['Grüße & Küsse', 'Gr&APwA3w-e &- K&APw-sse'],
		// The RFC's own example.
		['~peter/mail/台北/日本語', '~peter/mail/&U,BTFw-/&ZeVnLIqe-'],
		['Ablage/Übersicht/2026', 'Ablage/&ANw-bersicht/2026'],
	])('%j → %j', (name, wire) => {
		expect(encodeMailboxName(name)).toBe(wire);
		expect(decodeMailboxName(wire)).toBe(name);
	});

	it('leaves printable ASCII, the delimiter and the quoting specials as they are', () => {
		expect(encodeMailboxName('Projekte "Q4"')).toBe('Projekte "Q4"');
		expect(encodeMailboxName('Ablage\\2026')).toBe('Ablage\\2026');
		expect(encodeMailboxName('a/b c~')).toBe('a/b c~');
	});

	it('encodes C0 controls and DEL, so an encoded name never holds CR, LF or NUL', () => {
		expect(encodeMailboxName('a\r\nb')).toBe('a&AA0ACg-b');
		expect(encodeMailboxName('a\0b')).toBe('a&AAA-b');
		expect(encodeMailboxName('a\tb\x7f')).toBe('a&AAk-b&AH8-');
		expect(decodeMailboxName('a&AA0ACg-b')).toBe('a\r\nb');
	});

	it('agrees with the encoder and decoder ImapFlow uses', () => {
		const names = ['Übersicht', '📁 Mail', 'R&D', '~peter/mail/台北/日本語', 'Ä&Ö/ü 🎉&x', 'a\0b'];
		for (const name of names) {
			expect(encodeMailboxName(name)).toBe(encodePath(REV1, name));
			expect(decodePath(REV1, encodeMailboxName(name))).toBe(name);
			expect(decodeMailboxName(encodePath(REV1, name))).toBe(name);
		}
	});
});

describe('decodeMailboxName', () => {
	it('reads `&-` as `&`, also right after a base64 run', () => {
		expect(decodeMailboxName('&-')).toBe('&');
		expect(decodeMailboxName('&ANw-&-')).toBe('Ü&');
	});

	it.each([
		['an `&` with no closing `-`', 'AT&T'],
		['a run that encodes printable ASCII', '&AGE-'],
		['two base64 runs side by side', '&ANw-&AOQ-'],
		['non-zero padding bits', '&ANx-'],
		['a run too short for one code unit', '&AN-'],
		['a run with a stray sextet', '&ANwA-'],
		['a char outside modified base64', '&AN/-'],
		['raw non-ASCII', 'Übersicht'],
		['a raw control char', 'a\tb'],
	])('refuses %s', (_label, wire) => {
		expect(decodeMailboxName(wire)).toBeNull();
	});
});

describe('mailboxNameFromClient', () => {
	it('decodes modified UTF-7', () => {
		expect(mailboxNameFromClient('&ANw-bersicht')).toBe('Übersicht');
	});

	it('takes a name that is not modified UTF-7 as sent', () => {
		expect(mailboxNameFromClient('AT&T')).toBe('AT&T');
		expect(mailboxNameFromClient('Übersicht')).toBe('Übersicht');
		// Not the encoder's form of `Üä` (that is `&ANwA5A-`), so it is a name.
		expect(mailboxNameFromClient('&ANw-&AOQ-')).toBe('&ANw-&AOQ-');
		expect(mailboxNameFromClient('&ANwA5A-')).toBe('Üä');
	});
});

describe('imapMailboxName', () => {
	it.each([
		['Projekte "Q4"', '"Projekte \\"Q4\\""'],
		['Ablage\\2026', '"Ablage\\\\2026"'],
		['Übersicht', '"&ANw-bersicht"'],
		['R&D', '"R&-D"'],
		['a\r\nb', '"a&AA0ACg-b"'],
		['INBOX', '"INBOX"'],
	])('%j → %s', (name, wire) => {
		expect(imapMailboxName(name)).toBe(wire);
	});
});
