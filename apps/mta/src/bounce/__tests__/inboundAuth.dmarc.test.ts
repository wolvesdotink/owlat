/**
 * Inbound DMARC evaluation — RFC 7489 §4.1 / §6.6.2.
 *
 * `evaluateDmarc` binds SPF/DKIM (which authenticate the envelope MAIL FROM
 * and the `d=` domain) to the RFC5322.From domain via alignment + the From
 * domain's published `_dmarc` policy. These tests inject a hermetic
 * `policyLookup` (no real DNS) and assert:
 *
 *   (1) From=news@example.com + aligned DKIM pass            -> pass
 *   (2) From=ceo@bank.com, no DKIM, SPF pass for an unrelated
 *       envelope, bank.com p=reject                          -> fail, policy reject
 *   (3) subdomain From + relaxed alignment                   -> pass
 *   (4) integration: a spoofed .eml whose From-domain mocks
 *       p=quarantine is recorded dmarcResult='fail' on the
 *       mailbox payload (the Convex side then routes it to Spam)
 *   (5) forwarded message: envelope-SPF=fail but DKIM aligned
 *       pass                                                  -> pass (no over-reject)
 */

import { describe, it, expect } from 'vitest';
import { evaluateDmarc, type DmarcPolicyLookup } from '../inboundDmarc.js';

/** A `policyLookup` backed by a static domain -> `_dmarc` record map. */
function policyMap(records: Record<string, string>): DmarcPolicyLookup {
	return async (domain: string) => records[domain.toLowerCase()] ?? null;
}

describe('evaluateDmarc (RFC 7489)', () => {
	it('(1) aligned DKIM pass on the From domain -> pass', async () => {
		const outcome = await evaluateDmarc({
			fromDomain: 'example.com',
			spf: { result: 'none' },
			dkim: { result: 'pass', domain: 'example.com' },
			policyLookup: policyMap({ 'example.com': 'v=DMARC1; p=reject' }),
		});
		expect(outcome.result).toBe('pass');
		expect(outcome.dkimAligned).toBe(true);
	});

	it('(2) ceo@bank.com, no DKIM, SPF pass for an unrelated envelope, p=reject -> fail/reject', async () => {
		const outcome = await evaluateDmarc({
			fromDomain: 'bank.com',
			// SPF passed — but for the attacker's own envelope domain, which is
			// NOT aligned with the spoofed From (bank.com).
			spf: { result: 'pass', domain: 'evil-sender.example' },
			dkim: { result: 'none' },
			policyLookup: policyMap({ 'bank.com': 'v=DMARC1; p=reject' }),
		});
		expect(outcome.result).toBe('fail');
		expect(outcome.policy).toBe('reject');
		expect(outcome.spfAligned).toBe(false);
		expect(outcome.dkimAligned).toBe(false);
	});

	it('(3) subdomain From + relaxed alignment -> pass', async () => {
		// From is a subdomain; DKIM signs the parent. Relaxed alignment (the
		// DMARC default) treats them as the same Organizational Domain.
		const outcome = await evaluateDmarc({
			fromDomain: 'mail.acme.com',
			spf: { result: 'none' },
			dkim: { result: 'pass', domain: 'acme.com' },
			// No record on the subdomain → fall back to the org domain's record.
			policyLookup: policyMap({ 'acme.com': 'v=DMARC1; p=quarantine' }),
		});
		expect(outcome.result).toBe('pass');
		expect(outcome.dkimAligned).toBe(true);
	});

	it('(3b) strict alignment rejects a subdomain DKIM d=', async () => {
		// Same as (3) but the policy demands strict alignment — a subdomain From
		// no longer aligns with a parent-domain signature.
		const outcome = await evaluateDmarc({
			fromDomain: 'mail.acme.com',
			spf: { result: 'none' },
			dkim: { result: 'pass', domain: 'acme.com' },
			policyLookup: policyMap({ 'acme.com': 'v=DMARC1; p=quarantine; adkim=s' }),
		});
		expect(outcome.result).toBe('fail');
		expect(outcome.dkimAligned).toBe(false);
	});

	it('(5) forwarded message: envelope-SPF fail but aligned DKIM pass -> pass (no over-reject)', async () => {
		// A mailing-list / forwarder rewrites the envelope so SPF fails, but the
		// original DKIM signature survives and is aligned with the From domain.
		// DMARC MUST pass — a failed SPF must not drag an aligned-DKIM message to
		// fail (RFC 7489 §6.6.2: pass iff *either* aligned identifier passes).
		const outcome = await evaluateDmarc({
			fromDomain: 'newsletter.example',
			spf: { result: 'fail', domain: 'forwarder.example' },
			dkim: { result: 'pass', domain: 'newsletter.example' },
			policyLookup: policyMap({ 'newsletter.example': 'v=DMARC1; p=reject' }),
		});
		expect(outcome.result).toBe('pass');
		expect(outcome.spfAligned).toBe(false);
		expect(outcome.dkimAligned).toBe(true);
	});

	it('no DMARC record published -> result none', async () => {
		const outcome = await evaluateDmarc({
			fromDomain: 'no-dmarc.example',
			spf: { result: 'fail', domain: 'whatever.example' },
			dkim: { result: 'none' },
			policyLookup: policyMap({}),
		});
		expect(outcome.result).toBe('none');
		expect(outcome.policy).toBeUndefined();
	});

	it('transient policy-lookup failure -> temperror (fail-open)', async () => {
		const outcome = await evaluateDmarc({
			fromDomain: 'flaky.example',
			spf: { result: 'pass', domain: 'flaky.example' },
			dkim: { result: 'none' },
			policyLookup: async () => {
				throw Object.assign(new Error('SERVFAIL'), { code: 'ESERVFAIL' });
			},
		});
		expect(outcome.result).toBe('temperror');
	});

	it('aligned SPF pass on the From domain -> pass', async () => {
		const outcome = await evaluateDmarc({
			fromDomain: 'example.com',
			spf: { result: 'pass', domain: 'example.com' },
			dkim: { result: 'none' },
			policyLookup: policyMap({ 'example.com': 'v=DMARC1; p=reject' }),
		});
		expect(outcome.result).toBe('pass');
		expect(outcome.spfAligned).toBe(true);
	});
});

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
			},
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
