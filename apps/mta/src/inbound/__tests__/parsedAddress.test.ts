import { describe, it, expect } from 'vitest';
import { parseMessage } from '@owlat/mail-message';
import { evaluateDmarc } from '@owlat/mail-auth';
import { dmarcFromIdentity } from '../parsedAddress.js';

describe('dmarcFromIdentity — strict trust-boundary extraction', () => {
	it('accepts exactly one valid mailbox, including a quoted local-part', () => {
		for (const raw of [
			'From: CEO <ceo@victim.example>\r\n\r\nbody\r\n',
			'From: <ceo@victim.example>\r\n\r\nbody\r\n',
			'From: CEO (Accounts) <ceo@victim.example>\r\n\r\nbody\r\n',
			'From: "sales,@ops"@victim.example\r\n\r\nbody\r\n',
		]) {
			const parsed = parseMessage(Buffer.from(raw));
			expect(dmarcFromIdentity(parsed.from, parsed.rawFrom)).toEqual({
				domain: 'victim.example',
				invalid: false,
			});
		}
	});

	it.each([
		{
			name: 'two mailboxes hidden inside angle brackets',
			raw: 'From: <ceo@victim.example, attacker@attacker.example>\r\n\r\nbody\r\n',
		},
		{
			name: 'two whitespace-separated mailbox tokens',
			raw: 'From: attacker@attacker.example ceo@victim.example\r\n\r\nbody\r\n',
		},
		{
			name: 'trailing garbage after a mailbox',
			raw: 'From: attacker@attacker.example ignored-text\r\n\r\nbody\r\n',
		},
		{
			name: 'a normal two-mailbox list',
			raw: 'From: attacker@attacker.example, ceo@victim.example\r\n\r\nbody\r\n',
		},
		{
			name: 'repeated From fields',
			raw: 'From: ceo@victim.example\r\nFrom: attacker@attacker.example\r\n\r\nbody\r\n',
		},
		{
			name: 'group syntax',
			raw: 'From: Team: ceo@victim.example;\r\n\r\nbody\r\n',
		},
		{ name: 'unparseable value', raw: 'From: not-an-address\r\n\r\nbody\r\n' },
		{ name: 'empty value', raw: 'From:\r\n\r\nbody\r\n' },
		{ name: 'missing field', raw: 'To: user@example.org\r\n\r\nbody\r\n' },
	])('permerrors $name instead of aligning an attacker identity', async ({ raw }) => {
		const parsed = parseMessage(Buffer.from(raw));
		const identity = dmarcFromIdentity(parsed.from, parsed.rawFrom);
		expect(identity).toEqual({ domain: '', invalid: true });

		const outcome = await evaluateDmarc({
			fromDomain: identity.domain,
			fromAmbiguous: identity.invalid,
			spf: { result: 'none' },
			dkim: { result: 'pass', domain: 'attacker.example' },
			policyLookup: async () => 'v=DMARC1; p=reject',
		});
		expect(outcome.result).toBe('permerror');
	});
});
