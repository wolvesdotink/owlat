import { describe, it, expect } from 'vitest';
import { getListIdHeader } from '../listId';

// RFC 2919 List-Id grammar (the relevant productions):
//   List-Id value = [phrase] "<" list-id ">"
//   list-id       = list-label "." domain
//   list-label    = dot-atom-text        ; no spaces, no leading/trailing dot
//
// This regex matches the WHOLE header value: an optional quoted-string phrase,
// then the bracketed list-id whose label + domain are dot-atom-text (a run of
// atext/dots with no two consecutive dots and no boundary dots).
const DOT_ATOM = String.raw`[A-Za-z0-9!#$%&'*+/=?^_\`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_\`{|}~-]+)*`;
const LIST_ID_RE = new RegExp(`^(?:"(?:[^"\\\\]|\\\\.)*" )?<${DOT_ATOM}>$`);

// Extract the bracketed identifier (between the LAST `<` and `>`).
function bracketed(headerValue: string): string {
	const start = headerValue.lastIndexOf('<');
	const end = headerValue.lastIndexOf('>');
	expect(start).toBeGreaterThanOrEqual(0);
	expect(end).toBeGreaterThan(start);
	return headerValue.slice(start + 1, end);
}

describe('getListIdHeader (RFC 2919)', () => {
	it('produces a well-formed `"Name" <topic-<id>.<domain>>` value', () => {
		const value = getListIdHeader({
			domain: 'mail.acme.com',
			topic: { id: 'k1234abcd', name: 'Acme Newsletter' },
		});
		expect(value).toBe('"Acme Newsletter" <topic-k1234abcd.mail.acme.com>');
		expect(value).toMatch(LIST_ID_RE);
	});

	it('the bracketed identifier has no spaces', () => {
		const value = getListIdHeader({
			domain: 'mail.acme.com',
			topic: { id: 'k1234abcd', name: 'Weekly Digest' },
		});
		expect(value).not.toBeNull();
		const id = bracketed(value!);
		expect(id).not.toMatch(/\s/);
		// label "." domain — at least one dot joining label to host.
		expect(id).toContain('.');
	});

	it('the bracketed identifier is dot-atom on both sides of the topic-label join', () => {
		const value = getListIdHeader({
			domain: 'lists.example.org',
			topic: { id: 'abc123', name: 'X' },
		})!;
		const id = bracketed(value);
		// `topic-<label>.<domain>` — split off the leading `topic-<label>` (first
		// dot after the label) and assert each side is dot-atom-text.
		const firstDot = id.indexOf('.');
		const label = id.slice(0, firstDot);
		const domain = id.slice(firstDot + 1);
		const dotAtom = new RegExp(`^${DOT_ATOM}$`);
		expect(label).toMatch(dotAtom); // e.g. `topic-abc123`
		expect(label.startsWith('topic-')).toBe(true);
		expect(domain).toMatch(dotAtom); // `lists.example.org`
		// dot-atom: no leading/trailing dot, no two consecutive dots.
		expect(id.startsWith('.')).toBe(false);
		expect(id.endsWith('.')).toBe(false);
		expect(id).not.toContain('..');
	});

	it('lower-cases and strips an `@`-prefixed / scheme / path domain to a bare host', () => {
		const value = getListIdHeader({
			domain: 'NoReply@Mail.Acme.COM:587/path',
			topic: { id: 'k1', name: 'N' },
		})!;
		expect(bracketed(value)).toBe('topic-k1.mail.acme.com');
	});

	it('quotes the topic name as a phrase and escapes embedded quotes/backslashes', () => {
		const value = getListIdHeader({
			domain: 'mail.acme.com',
			topic: { id: 'k1', name: 'The "Best" \\ List' },
		})!;
		expect(value).toBe('"The \\"Best\\" \\\\ List" <topic-k1.mail.acme.com>');
		expect(value).toMatch(LIST_ID_RE);
	});

	it('neutralizes CR/LF in the topic name (no header injection)', () => {
		const value = getListIdHeader({
			domain: 'mail.acme.com',
			topic: { id: 'k1', name: 'Evil\r\nX-Injected: 1' },
		})!;
		expect(value).not.toContain('\r');
		expect(value).not.toContain('\n');
		expect(value).toMatch(LIST_ID_RE);
		// CR/LF collapse to a single space inside the quoted phrase.
		expect(value).toBe('"Evil X-Injected: 1" <topic-k1.mail.acme.com>');
	});

	it('emits no leading phrase for an empty / whitespace-only topic name', () => {
		const value = getListIdHeader({
			domain: 'mail.acme.com',
			topic: { id: 'k1', name: '   ' },
		})!;
		expect(value).toBe('<topic-k1.mail.acme.com>');
		expect(value).toMatch(LIST_ID_RE);
		expect(value.startsWith('<')).toBe(true);
	});

	it('returns null when the domain has no host-legal characters', () => {
		expect(
			getListIdHeader({ domain: '@@@', topic: { id: 'k1', name: 'N' } }),
		).toBeNull();
		expect(
			getListIdHeader({ domain: '', topic: { id: 'k1', name: 'N' } }),
		).toBeNull();
	});

	it('returns null when the topic id sanitizes away entirely', () => {
		expect(
			getListIdHeader({ domain: 'mail.acme.com', topic: { id: '...', name: 'N' } }),
		).toBeNull();
	});
});
