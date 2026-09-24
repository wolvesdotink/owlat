import { describe, it, expect } from 'vitest';
import { extractEmail, normalizeSubject, buildReplySubject, hasReplyPrefix } from '../emailAddress';

/**
 * Parity suite for `extractEmail`. `extractEmail` feeds inbound sender
 * resolution + `by_mailbox_and_subject` thread matching, so its output must be
 * byte-for-byte identical to the previous hand-inlined parser even after it was
 * routed through `@owlat/shared`'s `parseAddress`. These cases capture the
 * representative inputs (plain, Name <a@d>, mixed-case, trailing-dot domain,
 * empty/invalid) that the consolidation must not regress.
 */
describe('extractEmail (parity with the previous inlined parser)', () => {
	it('returns a plain address unchanged', () => {
		expect(extractEmail('user@example.com')).toBe('user@example.com');
	});

	it('unwraps a "Name <addr>" display-name form', () => {
		expect(extractEmail('John Doe <john@example.com>')).toBe('john@example.com');
	});

	it('unwraps a quoted display name', () => {
		expect(extractEmail('"John Doe" <john@example.com>')).toBe('john@example.com');
	});

	it('unwraps angle-bracket-only form', () => {
		expect(extractEmail('<john@example.com>')).toBe('john@example.com');
	});

	it('lowercases mixed-case local and domain parts', () => {
		expect(extractEmail('User@EXAMPLE.COM')).toBe('user@example.com');
	});

	it('trims surrounding whitespace and lowercases', () => {
		expect(extractEmail(' User@Acme.COM ')).toBe('user@acme.com');
	});

	it('preserves a trailing-dot domain (does NOT strip it — that is a domain concern)', () => {
		expect(extractEmail('user@example.com.')).toBe('user@example.com.');
	});

	it('handles a single-label domain inside angle brackets', () => {
		expect(extractEmail('Name <a@d>')).toBe('a@d');
	});

	it('returns empty string for empty input', () => {
		expect(extractEmail('')).toBe('');
	});

	it('returns empty string for whitespace-only input', () => {
		expect(extractEmail('   ')).toBe('');
	});

	it('falls back to the lowercased input when no address is present', () => {
		expect(extractEmail('no-at-here')).toBe('no-at-here');
	});

	it('falls back to the lowercased input for an empty angle pair', () => {
		expect(extractEmail('John Doe <>')).toBe('john doe <>');
	});
});

describe('normalizeSubject', () => {
	it('strips Re:/Fwd: prefixes and lowercases', () => {
		expect(normalizeSubject('Re: Fwd: Hello')).toBe('hello');
	});

	it('strips any depth of prefixes, not just two', () => {
		expect(normalizeSubject('Re: RE: Fwd: re: Hello')).toBe('hello');
	});

	it('strips localized and counted prefixes', () => {
		expect(normalizeSubject('AW: WG: Rechnung')).toBe('rechnung');
		expect(normalizeSubject('SV: Faktura')).toBe('faktura');
		expect(normalizeSubject('Re[2]: Hello')).toBe('hello');
		expect(normalizeSubject('Antw: Offerte')).toBe('offerte');
	});

	it('leaves a word that merely starts like a prefix alone', () => {
		expect(normalizeSubject('Report: Q3')).toBe('report: q3');
		expect(normalizeSubject('Svelte: migration')).toBe('svelte: migration');
	});
});

describe('hasReplyPrefix', () => {
	it('recognises English and localized reply markers', () => {
		expect(hasReplyPrefix('Re: Hello')).toBe(true);
		expect(hasReplyPrefix('RE: Hello')).toBe(true);
		expect(hasReplyPrefix('AW: Hallo')).toBe(true);
		expect(hasReplyPrefix('SV: Hej')).toBe(true);
		expect(hasReplyPrefix('Re[2]: Hello')).toBe(true);
	});

	it('does not treat a forward or an unprefixed subject as a reply', () => {
		expect(hasReplyPrefix('Fwd: Hello')).toBe(false);
		expect(hasReplyPrefix('WG: Hallo')).toBe(false);
		expect(hasReplyPrefix('Hello')).toBe(false);
		expect(hasReplyPrefix('Report: Q3')).toBe(false);
	});
});

describe('buildReplySubject', () => {
	it('does not double-prefix an existing Re:', () => {
		expect(buildReplySubject('RE: hi')).toBe('RE: hi');
	});

	it('adds a Re: prefix when absent', () => {
		expect(buildReplySubject('hi')).toBe('Re: hi');
	});
});
