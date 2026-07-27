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
} from './alignmentFixtures';

function statusOf(result: AlignmentPreflightResult, id: AlignmentCheckId) {
	return result.checks.find((entry) => entry.id === id)?.status;
}

describe('a per-transport From subdomain fails the check', () => {
	const result = evaluateAlignmentPreflight(
		alignedInput({
			ownArm: ownArm({ fromDomain: 'mta.acme.com', dkimDomain: 'mta.acme.com' }),
			dns: alignedDns({
				dkimTxt: {
					'owlat._domainkey.mta.acme.com': found(DKIM_KEY),
					'ses-token-1._domainkey.acme.com': found(DKIM_KEY),
				},
			}),
		})
	);

	it('is blocked, not warned', () => {
		expect(result.verdict).toBe('blocked');
		expect(result.allowsShareAboveZero).toBe(false);
		expect(statusOf(result, 'from_domain')).toBe('fail');
	});

	it('explains that per-stream subdomains are the correct shape', () => {
		const remedy = result.checks.find((entry) => entry.id === 'from_domain')?.remedy;
		expect(remedy).toBe(ALIGNMENT_REMEDIES.from_domain_mismatch);
		expect(remedy).toContain('per-stream subdomains');
	});
});

describe('a per-transport DKIM d= fails the check', () => {
	const result = evaluateAlignmentPreflight(
		alignedInput({
			ownArm: ownArm({ dkimDomain: 'mta.acme.com' }),
			dns: alignedDns({
				dkimTxt: {
					'owlat._domainkey.mta.acme.com': found(DKIM_KEY),
					'ses-token-1._domainkey.acme.com': found(DKIM_KEY),
				},
			}),
		})
	);

	it('blocks with the shared-d= remedy even though both keys resolve', () => {
		expect(result.verdict).toBe('blocked');
		expect(statusOf(result, 'from_domain')).toBe('pass');
		expect(statusOf(result, 'dkim')).toBe('fail');
		expect(result.checks.find((entry) => entry.id === 'dkim')?.remedy).toBe(
			ALIGNMENT_REMEDIES.dkim_domain_mismatch
		);
	});
});

describe('a per-STREAM subdomain shared by both arms still passes', () => {
	it('accepts news.acme.com on both arms', () => {
		const result = evaluateAlignmentPreflight(
			alignedInput({
				ownArm: ownArm({ fromDomain: 'news.acme.com', dkimDomain: 'news.acme.com' }),
				referenceArm: relayArm({ fromDomain: 'news.acme.com', dkimDomain: 'news.acme.com' }),
				dns: alignedDns({
					dmarcTxt: found(DMARC_RECORD),
					dkimTxt: {
						'owlat._domainkey.news.acme.com': found(DKIM_KEY),
						'ses-token-1._domainkey.news.acme.com': found(DKIM_KEY),
					},
				}),
			})
		);
		expect(result.verdict).toBe('aligned');
		expect(result.allowsShareAboveZero).toBe(true);
	});
});
