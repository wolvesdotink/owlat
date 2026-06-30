import { describe, it, expect } from 'vitest';
import { normalizeSubject, extractEmail, extractNameFromEmail } from '../inbox/messages';

// ============ normalizeSubject ============

describe('normalizeSubject', () => {
	it('strips single Re: prefix', () => {
		expect(normalizeSubject('Re: Hello World')).toBe('hello world');
	});

	it('strips Fwd: prefix', () => {
		expect(normalizeSubject('Fwd: Important Message')).toBe('important message');
	});

	it('strips FW: prefix', () => {
		expect(normalizeSubject('FW: Meeting Notes')).toBe('meeting notes');
	});

	it('strips nested Re: Re: prefixes', () => {
		expect(normalizeSubject('Re: Re: Discussion')).toBe('discussion');
	});

	it('strips Re: Fwd: mixed prefixes', () => {
		expect(normalizeSubject('Re: Fwd: Important')).toBe('important');
	});

	it('lowercases result', () => {
		expect(normalizeSubject('MEETING TOMORROW')).toBe('meeting tomorrow');
	});

	it('trims whitespace', () => {
		expect(normalizeSubject('  Hello  ')).toBe('hello');
	});

	it('handles RE: (uppercase)', () => {
		expect(normalizeSubject('RE: Update')).toBe('update');
	});

	it('handles re: (lowercase)', () => {
		expect(normalizeSubject('re: Update')).toBe('update');
	});

	it('handles various spacing around prefix', () => {
		expect(normalizeSubject('Re :  Hello')).toBe('hello');
	});

	it('returns empty string for only prefix', () => {
		expect(normalizeSubject('Re:')).toBe('');
	});

	it('returns empty string for empty input', () => {
		expect(normalizeSubject('')).toBe('');
	});

	it('passes through non-prefixed subjects unchanged (lowercased)', () => {
		expect(normalizeSubject('No prefix here')).toBe('no prefix here');
	});
});

// ============ extractEmail ============

describe('extractEmail', () => {
	it('extracts email from "Name <email>" format', () => {
		expect(extractEmail('John Doe <john@example.com>')).toBe('john@example.com');
	});

	it('returns raw string if no angle brackets', () => {
		expect(extractEmail('simple@example.com')).toBe('simple@example.com');
	});

	it('lowercases result', () => {
		expect(extractEmail('John <JOHN@EXAMPLE.COM>')).toBe('john@example.com');
	});

	it('trims whitespace', () => {
		expect(extractEmail('  john@example.com  ')).toBe('john@example.com');
	});

	it('handles complex display name', () => {
		expect(extractEmail('"John Q. Doe" <john@example.com>')).toBe('john@example.com');
	});
});

// ============ extractNameFromEmail ============

describe('extractNameFromEmail', () => {
	it('extracts first name from "First Last <email>" format', () => {
		expect(extractNameFromEmail('John Doe <john@example.com>')).toBe('John');
	});

	it('returns undefined when no name present', () => {
		expect(extractNameFromEmail('<john@example.com>')).toBeUndefined();
	});

	it('handles quoted names', () => {
		expect(extractNameFromEmail('"John Doe" <john@example.com>')).toBe('John');
	});

	it('returns first word only (first name)', () => {
		expect(extractNameFromEmail('John Michael Doe <j@e.com>')).toBe('John');
	});

	it('returns undefined for plain email without name', () => {
		expect(extractNameFromEmail('john@example.com')).toBeUndefined();
	});
});
