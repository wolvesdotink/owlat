/**
 * Inbound DMARC evaluation — RFC 7489 §4.1 / §6.6.2.
 *
 * Moved from `apps/mta/src/bounce/__tests__/inboundAuth.dmarc.test.ts` when the
 * DMARC evaluator relocated into `@owlat/mail-auth` (Own-the-Inbound A1). Every
 * assertion of the `evaluateDmarc (RFC 7489)` unit suite is unchanged (frozen
 * logic) — only the import specifier moved from `../inboundDmarc.js` to
 * `../dmarc.js`. The MTA-side integration block (which threads a spoofed .eml
 * through the bounce reducer `outcome.js`) stays in the MTA test file, now
 * importing `evaluateDmarc` from this package.
 *
 * `evaluateDmarc` binds SPF/DKIM (which authenticate the envelope MAIL FROM
 * and the `d=` domain) to the RFC5322.From domain via alignment + the From
 * domain's published `_dmarc` policy. These tests inject a hermetic
 * `policyLookup` (no real DNS).
 */

import { describe, it, expect } from 'vitest';
import { evaluateDmarc, type DmarcPolicyLookup } from '../dmarc.js';

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

	it('multi-label public suffix: From ceo@victim.co.uk aligned only to attacker.co.uk -> fail (bypass closed)', async () => {
		// Previously the org-domain heuristic folded both attacker.co.uk and
		// victim.co.uk to `co.uk`, so a DKIM/SPF pass for the attacker domain
		// looked "aligned" with the victim From — a DMARC bypass. It must now fail.
		const outcome = await evaluateDmarc({
			fromDomain: 'victim.co.uk',
			spf: { result: 'pass', domain: 'attacker.co.uk' },
			dkim: { result: 'pass', domain: 'attacker.co.uk' },
			policyLookup: policyMap({ 'victim.co.uk': 'v=DMARC1; p=reject' }),
		});
		expect(outcome.result).toBe('fail');
		expect(outcome.spfAligned).toBe(false);
		expect(outcome.dkimAligned).toBe(false);
	});

	it('multi-label public suffix: legitimate subdomain mail.victim.co.uk finds the victim.co.uk policy', async () => {
		// The From-domain → policy-domain fallback must still climb from a real
		// subdomain to its registrable parent under a ccTLD second-level suffix.
		const outcome = await evaluateDmarc({
			fromDomain: 'mail.victim.co.uk',
			spf: { result: 'none' },
			dkim: { result: 'pass', domain: 'victim.co.uk' },
			// No record on the subdomain; only the org domain publishes one.
			policyLookup: policyMap({ 'victim.co.uk': 'v=DMARC1; p=reject; sp=quarantine' }),
		});
		expect(outcome.result).toBe('pass');
		expect(outcome.dkimAligned).toBe(true);
		// `sp=` applies because the record was found on the org domain.
		expect(outcome.policy).toBe('quarantine');
	});

	it('ambiguous From (multiple From headers / addresses) -> permerror, never pass (RFC 7489 §6.6.1)', async () => {
		const outcome = await evaluateDmarc({
			fromDomain: 'example.com',
			fromAmbiguous: true,
			// Even a perfectly aligned DKIM pass must not rescue an ambiguous From.
			spf: { result: 'pass', domain: 'example.com' },
			dkim: { result: 'pass', domain: 'example.com' },
			policyLookup: policyMap({ 'example.com': 'v=DMARC1; p=reject' }),
		});
		expect(outcome.result).toBe('permerror');
		expect(outcome.result).not.toBe('pass');
	});
});
