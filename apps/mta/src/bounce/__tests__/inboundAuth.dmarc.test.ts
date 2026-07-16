/**
 * MTA-side DMARC integration — a spoofed message is recorded dmarcResult=fail.
 *
 * The pure `evaluateDmarc (RFC 7489)` unit suite moved into
 * `packages/mail-auth/src/__tests__/inboundAuth.dmarc.test.ts` when the DMARC
 * evaluator relocated to `@owlat/mail-auth` (Own-the-Inbound A1). This file
 * keeps the MTA-specific integration test, which threads a spoofed .eml through
 * the bounce reducer (`outcome.js`) and asserts the DMARC verdict + policy reach
 * the mailbox payload so Convex routes the spoof to Spam. It now imports
 * `evaluateDmarc` from the package.
 */

import { describe, it, expect } from 'vitest';
import { evaluateDmarc, type DmarcPolicyLookup } from '@owlat/mail-auth';

/** A `policyLookup` backed by a static domain -> `_dmarc` record map. */
function policyMap(records: Record<string, string>): DmarcPolicyLookup {
	return async (domain: string) => records[domain.toLowerCase()] ?? null;
}

describe('integration: a spoofed p=quarantine message is recorded dmarcResult=fail (PR-37)', () => {
	it('reduceMailbox threads a DMARC fail onto the mailbox payload', async () => {
		const { reduce } = await import('../outcome.js');
		const { simpleParser } = await import('mailparser');
		const { emailDomain } = await import('@owlat/shared/spfAlignment');

		// A spoofed message: the visible From claims victim.example, but nothing
		// authenticates it (no DKIM, SPF for an unrelated envelope).
		const spoofed = [
			'From: "Billing" <billing@victim.example>',
			'To: me@example.com',
			'Subject: Your invoice is overdue',
			'Date: Tue, 17 Jun 2026 12:00:00 +0000',
			'Message-ID: <spoof-1@attacker.example>',
			'MIME-Version: 1.0',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'Pay here: http://attacker.example/pay',
			'',
		].join('\r\n');
		const rawBuffer = Buffer.from(spoofed);
		const parsed = await simpleParser(rawBuffer);

		const fromDomain = emailDomain(parsed.from?.value?.[0]?.address ?? '');
		const dmarc = await evaluateDmarc({
			fromDomain,
			spf: { result: 'pass', domain: 'attacker.example' },
			dkim: { result: 'none' },
			policyLookup: policyMap({ 'victim.example': 'v=DMARC1; p=quarantine' }),
		});
		expect(dmarc.result).toBe('fail');
		expect(dmarc.policy).toBe('quarantine');

		const { effects } = reduce(
			{
				kind: 'mailbox',
				mailbox: {
					organizationId: 'org_1',
					recipientAddress: 'me@example.com',
					quotaBytes: null,
					usedBytes: 0,
				} as never,
				rcptTo: 'me@example.com',
				attachments: [],
				toAddrs: ['me@example.com'],
				ccAddrs: [],
				bccAddrs: [],
				references: undefined,
				dkimResult: 'none',
				dmarcResult: dmarc.result,
				dmarcPolicy: dmarc.policy,
			},
			{
				parsed,
				rawBuffer,
				rcptTo: 'me@example.com',
				dmarcResult: dmarc.result,
				dmarcPolicy: dmarc.policy,
			}
		);

		const notify = effects.find((e) => e.kind === 'notify_convex');
		expect(notify).toBeDefined();
		if (notify && notify.kind === 'notify_convex') {
			expect(notify.event.event).toBe('inbound.mailbox.received');
			// The verdict + the enforcing policy both reach the payload so Convex
			// can route the spoof to Spam (initialRole 'spam').
			expect(notify.event.mailboxPayload?.dmarcResult).toBe('fail');
			expect(notify.event.mailboxPayload?.dmarcPolicy).toBe('quarantine');
		}
	});
});
