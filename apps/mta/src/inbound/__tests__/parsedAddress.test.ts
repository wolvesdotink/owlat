import { describe, it, expect } from 'vitest';
import { parseMessage, type AddressObject } from '@owlat/mail-message';
import { evaluateDmarc } from '@owlat/mail-auth';
import { emailDomain } from '@owlat/shared/spfAlignment';
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

	it('preserves raw duplicate From evidence and prevents an aligned DMARC pass', async () => {
		const parsed = parseMessage(
			Buffer.from(
				[
					'From: CEO <ceo@victim.example>',
					'From: attacker@attacker.example',
					'To: user@example.org',
					'',
					'body',
					'',
				].join('\r\n')
			)
		);

		// The consumed display field remains mailparser-compatible (last wins),
		// while the raw count retains the trust-boundary evidence DMARC needs.
		expect(firstAddress(parsed.from)).toBe('attacker@attacker.example');
		expect(parsed.headerCounts.get('from')).toBe(2);
		const fromAmbiguous = isFromAmbiguous(parsed.from, parsed.headerCounts.get('from'));
		expect(fromAmbiguous).toBe(true);

		const outcome = await evaluateDmarc({
			fromDomain: emailDomain(firstAddress(parsed.from) ?? ''),
			fromAmbiguous,
			spf: { result: 'none' },
			dkim: { result: 'pass', domain: 'attacker.example' },
			policyLookup: async () => 'v=DMARC1; p=reject',
		});
		expect(outcome.result).toBe('permerror');
	});
});
