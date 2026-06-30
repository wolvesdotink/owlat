import { describe, it, expect } from 'vitest';
import {
	parseAddress,
	parseAddressList,
	extractDomain,
	extractDomainOrNull,
} from '../address';

describe('parseAddress', () => {
	it('parses a bare email', () => {
		expect(parseAddress('me@hl.camp')).toEqual({ address: 'me@hl.camp' });
	});

	it('lowercases the address', () => {
		expect(parseAddress('Me@HL.Camp')).toEqual({ address: 'me@hl.camp' });
	});

	it('parses an angle-bracketed address with a name', () => {
		expect(parseAddress('Marcel <me@hl.camp>')).toEqual({ name: 'Marcel', address: 'me@hl.camp' });
	});

	it('strips surrounding quotes from the name', () => {
		expect(parseAddress('"Marcel Pfeifer" <me@hl.camp>')).toEqual({
			name: 'Marcel Pfeifer',
			address: 'me@hl.camp',
		});
	});

	it('returns null when no address can be parsed', () => {
		expect(parseAddress('no email here')).toBeNull();
		expect(parseAddress('')).toBeNull();
	});

	it('returns null for an angle-bracketed string without @', () => {
		expect(parseAddress('Bad <invalid>')).toBeNull();
	});
});

describe('parseAddressList', () => {
	it('parses a single address', () => {
		expect(parseAddressList('me@hl.camp')).toEqual([{ address: 'me@hl.camp' }]);
	});

	it('parses multiple comma-separated addresses', () => {
		expect(parseAddressList('a@x.com, b@y.com')).toEqual([
			{ address: 'a@x.com' },
			{ address: 'b@y.com' },
		]);
	});

	it('preserves comma inside quoted name', () => {
		expect(parseAddressList('"Smith, John" <john@x.com>, jane@y.com')).toEqual([
			{ name: 'Smith, John', address: 'john@x.com' },
			{ address: 'jane@y.com' },
		]);
	});

	it('handles addresses with display names and bare addresses mixed', () => {
		expect(parseAddressList('Alice <a@x.com>, b@y.com, "Bob" <c@z.com>')).toEqual([
			{ name: 'Alice', address: 'a@x.com' },
			{ address: 'b@y.com' },
			{ name: 'Bob', address: 'c@z.com' },
		]);
	});

	it('returns an empty list for empty input', () => {
		expect(parseAddressList('')).toEqual([]);
	});
});

describe('extractDomain', () => {
	it('extracts the domain from a bare address', () => {
		expect(extractDomain('me@hl.camp')).toBe('hl.camp');
	});

	it('extracts the domain from an angle-bracketed address', () => {
		expect(extractDomain('Marcel <me@hl.camp>')).toBe('hl.camp');
	});

	it('lowercases the domain', () => {
		expect(extractDomain('me@HL.CAMP')).toBe('hl.camp');
	});

	it('throws on invalid input', () => {
		expect(() => extractDomain('not an email')).toThrow(/Invalid email/);
		expect(() => extractDomain('')).toThrow(/Invalid email/);
	});
});

describe('extractDomainOrNull', () => {
	it('returns the domain on success', () => {
		expect(extractDomainOrNull('me@hl.camp')).toBe('hl.camp');
	});

	it('returns null on invalid input instead of throwing', () => {
		expect(extractDomainOrNull('not an email')).toBeNull();
		expect(extractDomainOrNull('')).toBeNull();
	});

	it('handles display-name wrapped addresses', () => {
		expect(extractDomainOrNull('"Marcel" <me@hl.camp>')).toBe('hl.camp');
	});
});
