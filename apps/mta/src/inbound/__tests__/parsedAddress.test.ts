import { describe, it, expect } from 'vitest';
import type { AddressObject } from '@owlat/mail-message';
import { isFromAmbiguous, firstAddress } from '../parsedAddress.js';

const one: AddressObject = {
	value: [{ name: 'A', address: 'a@x.test' }],
	text: 'A <a@x.test>',
};
const twoMailboxes: AddressObject = {
	value: [
		{ name: '', address: 'a@evil.test' },
		{ name: '', address: 'b@bank.test' },
	],
	text: 'a@evil.test, b@bank.test',
};

describe('isFromAmbiguous (RFC 7489 §6.6.1)', () => {
	it('is false for an absent From', () => {
		expect(isFromAmbiguous(undefined)).toBe(false);
	});

	it('is false for a single From with one mailbox', () => {
		expect(isFromAmbiguous(one)).toBe(false);
		// sanity: the single, unambiguous case is exactly what DMARC binds to
		expect(firstAddress(one)).toBe('a@x.test');
	});

	it('is true for a single From naming more than one mailbox', () => {
		expect(isFromAmbiguous(twoMailboxes)).toBe(true);
	});

	it('is true when the From header occurs more than once (array arm)', () => {
		expect(isFromAmbiguous([one, twoMailboxes])).toBe(true);
	});
});
