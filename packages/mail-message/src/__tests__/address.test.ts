import { describe, it, expect } from 'vitest';
import {
	parseAddressList,
	parseAddressObject,
	parseAddressObjects,
	formatAddress,
} from '../parse/address';

describe('parseAddressObject — mailboxes', () => {
	it('parses a plain address with no display name', () => {
		const obj = parseAddressObject('jane@example.com');
		expect(obj.value).toEqual([{ name: '', address: 'jane@example.com' }]);
		expect(obj.text).toBe('jane@example.com');
	});

	it('lowercases the address and keeps the display name', () => {
		const obj = parseAddressObject('Jane Doe <Jane@Example.COM>');
		expect(obj.value).toEqual([{ name: 'Jane Doe', address: 'jane@example.com' }]);
	});

	it('decodes an RFC 2047 encoded-word display name', () => {
		const obj = parseAddressObject('=?utf-8?B?w6k=?= <e@x.com>');
		expect(obj.value[0]?.name).toBe('é');
	});
});

describe('parseAddressObject — quoted commas', () => {
	it('does not split on a comma inside a quoted display name', () => {
		const obj = parseAddressObject('"Doe, John" <john@example.com>, jane@example.com');
		expect(obj.value).toEqual([
			{ name: 'Doe, John', address: 'john@example.com' },
			{ name: '', address: 'jane@example.com' },
		]);
	});

	it('reconstructs .text with the quoted name preserved', () => {
		const obj = parseAddressObject('"Doe, John" <john@example.com>, jane@example.com');
		expect(obj.text).toBe('"Doe, John" <john@example.com>, jane@example.com');
	});
});

describe('parseAddressObject — RFC 5322 groups', () => {
	it('parses a group into a container entry with members', () => {
		const obj = parseAddressObject('Friends: alice@example.com, bob@example.com;');
		expect(obj.value).toEqual([
			{
				name: 'Friends',
				address: '',
				group: [
					{ name: '', address: 'alice@example.com' },
					{ name: '', address: 'bob@example.com' },
				],
			},
		]);
	});

	it('reconstructs a group in .text', () => {
		const obj = parseAddressObject('Friends: alice@example.com, bob@example.com;');
		expect(obj.text).toBe('Friends: alice@example.com, bob@example.com;');
	});

	it('handles an empty group (undisclosed recipients)', () => {
		const obj = parseAddressObject('Undisclosed recipients:;');
		expect(obj.value).toEqual([{ name: 'Undisclosed recipients', address: '', group: [] }]);
		expect(obj.text).toBe('Undisclosed recipients:;');
	});

	it('parses a mailbox alongside a group', () => {
		const list = parseAddressList('root@x.com, Team: a@y.com;');
		expect(list.map((e) => e.address)).toEqual(['root@x.com', '']);
		expect(list[1]?.group?.map((m) => m.address)).toEqual(['a@y.com']);
	});

	it('closes an unterminated group at end of input', () => {
		const list = parseAddressList('Team: a@y.com, b@z.com');
		expect(list[0]?.group?.map((m) => m.address)).toEqual(['a@y.com', 'b@z.com']);
	});
});

describe('formatAddress', () => {
	it('quotes an empty group name-less container as an empty group', () => {
		expect(formatAddress({ name: 'G', address: '', group: [] })).toBe('G:;');
	});
	it('emits a bare address when there is no name', () => {
		expect(formatAddress({ name: '', address: 'a@b.com' })).toBe('a@b.com');
	});
});

describe('parseAddressObjects — single-vs-array duality', () => {
	it('returns undefined when the header is absent', () => {
		expect(parseAddressObjects([])).toBeUndefined();
	});
	it('returns a single object for one header value', () => {
		const one = parseAddressObjects(['a@x.com']);
		expect(Array.isArray(one)).toBe(false);
		expect((one as { text: string }).text).toBe('a@x.com');
	});
	it('returns an array when the header is repeated', () => {
		const many = parseAddressObjects(['a@x.com', 'b@y.com']);
		expect(Array.isArray(many)).toBe(true);
		expect((many as Array<{ text: string }>).map((o) => o.text)).toEqual(['a@x.com', 'b@y.com']);
	});
});
