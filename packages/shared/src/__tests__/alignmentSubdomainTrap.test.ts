/**
 * D11 — the per-transport subdomain trap.
 *
 * Giving the own-MTA arm its own From subdomain or its own DKIM `d=` splits
 * domain reputation, throws away the reputation the relay arm spent weeks
 * building, and makes the two arms incomparable. Any configuration that does it
 * must FAIL this check — not warn.
 *
 * Per-STREAM subdomains are the legitimate, separate thing: the same
 * `news.acme.com` on BOTH arms must still pass.
 */

import { describe, expect, it } from 'vitest';
import {
	ALIGNMENT_REMEDIES,
	evaluateAlignmentPreflight,
	type AlignmentCheckId,
	type AlignmentPreflightResult,
} from '../deliverabilityAlignment';
import {
	alignedDns,
	alignedInput,
	DKIM_KEY,
	DMARC_RECORD,
	found,
	ownArm,
	relayArm,
	OWN_SPF_MECHANISM,
	RELAY_SPF_MECHANISM,
} from './alignmentFixtures';

function check(result: AlignmentPreflightResult, id: AlignmentCheckId) {
	const match = result.checks.find((entry) => entry.id === id);
	if (!match) throw new Error(`no ${id} check in result`);
	return match;
}

describe('a per-transport From subdomain is a hard failure', () => {
	it('fails the From-domain check when the own arm gets mail.acme.com', () => {
		const result = evaluateAlignmentPreflight(
			alignedInput({ ownArm: ownArm({ fromDomain: 'mail.acme.com' }) })
		);
		const fromDomain = check(result, 'from_domain');
		expect(fromDomain.status).toBe('fail');
		expect(fromDomain.detail).toContain('own MTA sends from mail.acme.com');
		expect(fromDomain.detail).toContain('SES relay sends from acme.com');
		expect(fromDomain.remedy).toBe(ALIGNMENT_REMEDIES.from_domain_mismatch);
		expect(result.verdict).toBe('blocked');
		expect(result.allowsShareAboveZero).toBe(false);
	});

	it('fails when the RELAY arm is the one given the subdomain', () => {
		const result = evaluateAlignmentPreflight(
			alignedInput({
				reference: { kind: 'arm', arm: relayArm({ fromDomain: 'relay.acme.com' }) },
			})
		);
		expect(check(result, 'from_domain').status).toBe('fail');
		expect(result.allowsShareAboveZero).toBe(false);
	});
});

describe('a per-transport DKIM d= is a hard failure', () => {
	it('fails the DKIM check when the own arm signs a different d=', () => {
		const result = evaluateAlignmentPreflight(
			alignedInput({ ownArm: ownArm({ dkimDomain: 'mta.acme.com' }) })
		);
		const dkim = check(result, 'dkim');
		expect(dkim.status).toBe('fail');
		expect(dkim.detail).toContain('d=mta.acme.com');
		expect(dkim.remedy).toBe(ALIGNMENT_REMEDIES.dkim_domain_mismatch);
		expect(result.verdict).toBe('blocked');
	});

	it('fails when both arms sign the same d= with the SAME selector', () => {
		const result = evaluateAlignmentPreflight(
			alignedInput({
				reference: { kind: 'arm', arm: relayArm({ dkimSelectors: ['owlat'] }) },
			})
		);
		const dkim = check(result, 'dkim');
		expect(dkim.status).toBe('fail');
		expect(dkim.remedy).toBe(ALIGNMENT_REMEDIES.dkim_selector_collision);
	});
});

describe('a per-STREAM subdomain on BOTH arms is legitimate', () => {
	it('passes when both arms use news.acme.com identically', () => {
		const result = evaluateAlignmentPreflight({
			ownArm: ownArm({ fromDomain: 'news.acme.com', dkimDomain: 'news.acme.com' }),
			reference: {
				kind: 'arm',
				arm: relayArm({ fromDomain: 'news.acme.com', dkimDomain: 'news.acme.com' }),
			},
			dns: alignedDns({
				fromDomainTxt: found(`v=spf1 ${OWN_SPF_MECHANISM} ${RELAY_SPF_MECHANISM} ~all`),
				dmarcTxt: found(DMARC_RECORD),
				dkimTxt: {
					'owlat._domainkey.news.acme.com': found(DKIM_KEY),
					'ses-token-1._domainkey.news.acme.com': found(DKIM_KEY),
				},
			}),
			checkedAt: 1_800_000_000_000,
		});
		expect(result.verdict).toBe('aligned');
		expect(result.allowsShareAboveZero).toBe(true);
	});
});
