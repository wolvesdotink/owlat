/**
 * The four alignment checks against live-DNS fixtures — each PASSING and each
 * FAILING independently, with the exact remedy text asserted per failure.
 */

import { describe, expect, it } from 'vitest';
import {
	ALIGNMENT_CHECK_IDS,
	ALIGNMENT_RECHECK_INTERVAL_MS,
	ALIGNMENT_REMEDIES,
	evaluateAlignmentPreflight,
	type AlignmentCheckId,
	type AlignmentPreflightResult,
} from '../deliverabilityAlignment';
import {
	alignedDns,
	alignedInput,
	CHECKED_AT,
	DKIM_KEY,
	DMARC_RECORD,
	found,
	ownArm,
	relayArm,
} from './alignmentFixtures';

function check(result: AlignmentPreflightResult, id: AlignmentCheckId) {
	const match = result.checks.find((entry) => entry.id === id);
	if (!match) throw new Error(`no ${id} check in result`);
	return match;
}

describe('alignment pre-flight — all four checks pass', () => {
	const result = evaluateAlignmentPreflight(alignedInput());

	it('reports every check as a pass and opens the gate', () => {
		expect(result.verdict).toBe('aligned');
		expect(result.allowsShareAboveZero).toBe(true);
		expect(result.checks.map((entry) => entry.id)).toEqual([...ALIGNMENT_CHECK_IDS]);
		expect(result.checks.every((entry) => entry.status === 'pass')).toBe(true);
	});

	it('leaves the remedy empty on a pass and schedules the daily re-check', () => {
		expect(result.checks.every((entry) => entry.remedy === '')).toBe(true);
		expect(result.nextCheckDueAt).toBe(CHECKED_AT + ALIGNMENT_RECHECK_INTERVAL_MS);
	});

	it('reports the SPF lookup budget it actually measured', () => {
		expect(check(result, 'spf').detail).toContain('1 of 10 DNS lookups');
	});
});

describe('from-domain check fails independently', () => {
	const result = evaluateAlignmentPreflight(
		alignedInput({ referenceArm: relayArm({ fromDomain: 'mail.acme.com' }) })
	);

	it('blocks with the per-transport-subdomain remedy', () => {
		expect(result.verdict).toBe('blocked');
		expect(result.allowsShareAboveZero).toBe(false);
		expect(check(result, 'from_domain').status).toBe('fail');
		expect(check(result, 'from_domain').remedy).toBe(ALIGNMENT_REMEDIES.from_domain_mismatch);
	});
});

describe('SPF check fails independently', () => {
	it('names the missing mechanism when the record does not cover both arms', () => {
		const result = evaluateAlignmentPreflight(
			alignedInput({ dns: alignedDns({ fromDomainTxt: found('v=spf1 ip4:203.0.113.10 ~all') }) })
		);
		expect(result.verdict).toBe('blocked');
		expect(check(result, 'spf').remedy).toBe(
			`${ALIGNMENT_REMEDIES.spf_missing_mechanism} Missing: include:amazonses.com.`
		);
	});

	it('fails when no SPF record is published at all', () => {
		const result = evaluateAlignmentPreflight(
			alignedInput({ dns: alignedDns({ fromDomainTxt: { state: 'absent' } }) })
		);
		expect(check(result, 'spf').remedy).toBe(ALIGNMENT_REMEDIES.spf_no_record);
	});

	it('fails when two v=spf1 records are published (a PermError in itself)', () => {
		const result = evaluateAlignmentPreflight(
			alignedInput({
				dns: alignedDns({
					fromDomainTxt: found('v=spf1 ip4:203.0.113.10 ~all', 'v=spf1 include:amazonses.com ~all'),
				}),
			})
		);
		expect(check(result, 'spf').remedy).toBe(ALIGNMENT_REMEDIES.spf_multiple_records);
	});
});

describe('DKIM check fails independently', () => {
	it('fails when an arm publishes no key', () => {
		const dns = alignedDns();
		const result = evaluateAlignmentPreflight(
			alignedInput({
				dns: {
					...dns,
					dkimTxt: { ...dns.dkimTxt, 'ses-token-1._domainkey.acme.com': { state: 'absent' } },
				},
			})
		);
		expect(result.verdict).toBe('blocked');
		expect(check(result, 'dkim').remedy).toBe(ALIGNMENT_REMEDIES.dkim_missing_record);
	});

	it('fails on a revoked (empty p=) key', () => {
		const dns = alignedDns();
		const result = evaluateAlignmentPreflight(
			alignedInput({
				dns: {
					...dns,
					dkimTxt: {
						...dns.dkimTxt,
						'ses-token-1._domainkey.acme.com': found('v=DKIM1; k=rsa; p='),
					},
				},
			})
		);
		expect(check(result, 'dkim').remedy).toBe(ALIGNMENT_REMEDIES.dkim_revoked);
	});

	it('fails when both arms would sign with the SAME selector', () => {
		const result = evaluateAlignmentPreflight(
			alignedInput({
				referenceArm: relayArm({ dkimSelectors: ['owlat'] }),
				dns: alignedDns({ dkimTxt: { 'owlat._domainkey.acme.com': found(DKIM_KEY) } }),
			})
		);
		expect(check(result, 'dkim').remedy).toBe(ALIGNMENT_REMEDIES.dkim_selector_collision);
	});

	it('fails when the shared d= does not align with the From domain', () => {
		const result = evaluateAlignmentPreflight(
			alignedInput({
				ownArm: ownArm({ dkimDomain: 'acme-mail.net' }),
				referenceArm: relayArm({ dkimDomain: 'acme-mail.net' }),
				dns: alignedDns({
					dkimTxt: {
						'owlat._domainkey.acme-mail.net': found(DKIM_KEY),
						'ses-token-1._domainkey.acme-mail.net': found(DKIM_KEY),
					},
				}),
			})
		);
		expect(check(result, 'dkim').remedy).toBe(ALIGNMENT_REMEDIES.dkim_unaligned);
	});
});

describe('DMARC check fails independently', () => {
	it('fails when no DMARC record is published', () => {
		const result = evaluateAlignmentPreflight(
			alignedInput({ dns: alignedDns({ dmarcTxt: { state: 'absent' } }) })
		);
		expect(result.verdict).toBe('blocked');
		expect(check(result, 'dmarc').remedy).toBe(ALIGNMENT_REMEDIES.dmarc_missing_record);
	});

	it('fails when two DMARC records are published', () => {
		const result = evaluateAlignmentPreflight(
			alignedInput({ dns: alignedDns({ dmarcTxt: found(DMARC_RECORD, 'v=DMARC1; p=none') }) })
		);
		expect(check(result, 'dmarc').remedy).toBe(ALIGNMENT_REMEDIES.dmarc_multiple_records);
	});

	it('fails when adkim=s and an arm signs with a subdomain d=', () => {
		const result = evaluateAlignmentPreflight(
			alignedInput({
				ownArm: ownArm({ dkimDomain: 'mail.acme.com' }),
				referenceArm: relayArm({ dkimDomain: 'mail.acme.com' }),
				dns: alignedDns({
					dmarcTxt: found('v=DMARC1; p=reject; adkim=s'),
					dkimTxt: {
						'owlat._domainkey.mail.acme.com': found(DKIM_KEY),
						'ses-token-1._domainkey.mail.acme.com': found(DKIM_KEY),
					},
				}),
			})
		);
		expect(check(result, 'dmarc').remedy).toBe(ALIGNMENT_REMEDIES.dmarc_strict_alignment);
	});
});

describe('Return-Path state is recorded, never blocking (P2-3)', () => {
	const result = evaluateAlignmentPreflight(
		alignedInput({ referenceArm: relayArm({ supportsCustomReturnPath: false }) })
	);

	it('flags degraded measurement while still allowing the ramp', () => {
		expect(result.verdict).toBe('aligned');
		expect(result.allowsShareAboveZero).toBe(true);
		expect(result.degradedMeasurement).toBe(true);
		expect(result.degradedMeasurementReason).toContain('Measurement confidence is lowered');
		expect(result.checks.every((entry) => entry.status === 'pass')).toBe(true);
	});
});
