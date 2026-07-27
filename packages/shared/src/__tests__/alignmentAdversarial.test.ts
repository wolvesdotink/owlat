/**
 * Adversarial and degenerate inputs.
 *
 * The load-bearing rule: a DNS timeout / SERVFAIL / REFUSED is UNKNOWN and
 * HOLDS. Treating an unresolved lookup as "aligned" would let a misconfigured
 * cell ramp; treating it as "failed" would raise an alarm about a configuration
 * that may be perfectly fine. Neither is acceptable, so `unknown` is its own
 * state everywhere — in the check, in the verdict, and in the gate.
 */

import { describe, expect, it } from 'vitest';
import {
	ALIGNMENT_REMEDIES,
	ALIGNMENT_STALE_AFTER_MS,
	ALIGNMENT_UNKNOWN_RETRY_MS,
	alignmentGate,
	applyAlignmentGateToShare,
	evaluateAlignmentPreflight,
	type DnsLookupFailure,
} from '../deliverabilityAlignment';
import {
	alignedDns,
	alignedInput,
	CHECKED_AT,
	DKIM_KEY,
	found,
	ownArm,
	relayArm,
} from './alignmentFixtures';

const FAILURES: DnsLookupFailure[] = ['timeout', 'servfail', 'refused', 'error'];

describe('an unresolved lookup is UNKNOWN, never aligned and never a fault', () => {
	for (const failure of FAILURES) {
		it(`holds on a ${failure} at the From domain`, () => {
			const result = evaluateAlignmentPreflight(
				alignedInput({ dns: alignedDns({ fromDomainTxt: { state: 'unknown', failure } }) })
			);
			expect(result.verdict).toBe('unknown');
			expect(result.allowsShareAboveZero).toBe(false);
			const spf = result.checks.find((entry) => entry.id === 'spf');
			expect(spf?.status).toBe('unknown');
			expect(spf?.remedy).toBe(ALIGNMENT_REMEDIES.dns_unknown);
			expect(spf?.detail).toContain(failure);
		});
	}

	it('holds on an unresolved DKIM lookup', () => {
		const dns = alignedDns();
		const result = evaluateAlignmentPreflight(
			alignedInput({
				dns: {
					...dns,
					dkimTxt: {
						...dns.dkimTxt,
						'ses-token-1._domainkey.acme.com': { state: 'unknown', failure: 'timeout' },
					},
				},
			})
		);
		expect(result.verdict).toBe('unknown');
		expect(result.checks.find((entry) => entry.id === 'dkim')?.status).toBe('unknown');
	});

	it('holds on an unresolved DMARC lookup', () => {
		const result = evaluateAlignmentPreflight(
			alignedInput({ dns: alignedDns({ dmarcTxt: { state: 'unknown', failure: 'servfail' } }) })
		);
		expect(result.verdict).toBe('unknown');
		expect(result.checks.find((entry) => entry.id === 'dmarc')?.status).toBe('unknown');
	});

	it('retries sooner than the daily cadence rather than sitting on the unknown', () => {
		const result = evaluateAlignmentPreflight(
			alignedInput({ dns: alignedDns({ dmarcTxt: { state: 'unknown', failure: 'timeout' } }) })
		);
		expect(result.nextCheckDueAt).toBe(CHECKED_AT + ALIGNMENT_UNKNOWN_RETRY_MS);
	});

	it('reports a real FAILURE ahead of an unknown when both are present', () => {
		const dns = alignedDns();
		const result = evaluateAlignmentPreflight(
			alignedInput({
				dns: {
					fromDomainTxt: { state: 'unknown', failure: 'timeout' },
					dmarcTxt: { state: 'absent' },
					dkimTxt: dns.dkimTxt,
				},
			})
		);
		expect(result.verdict).toBe('blocked');
		expect(result.allowsShareAboveZero).toBe(false);
	});
});

describe('degenerate configuration is a failure, never a pass', () => {
	it('fails when an arm has no selector configured at all', () => {
		const result = evaluateAlignmentPreflight(
			alignedInput({ referenceArm: relayArm({ dkimSelectors: [] }) })
		);
		expect(result.verdict).toBe('blocked');
		expect(result.checks.find((entry) => entry.id === 'dkim')?.status).toBe('fail');
	});

	it('holds rather than passing when a selector was never observed', () => {
		const result = evaluateAlignmentPreflight(alignedInput({ dns: alignedDns({ dkimTxt: {} }) }));
		expect(result.verdict).toBe('unknown');
		expect(result.allowsShareAboveZero).toBe(false);
	});

	it('fails on an empty From domain rather than matching two blanks', () => {
		const result = evaluateAlignmentPreflight(
			alignedInput({
				ownArm: ownArm({ fromDomain: '   ' }),
				referenceArm: relayArm({ fromDomain: '' }),
			})
		);
		expect(result.checks.find((entry) => entry.id === 'from_domain')?.status).toBe('fail');
	});

	it('ignores a TXT record at the DKIM name that is not a DKIM key', () => {
		const dns = alignedDns();
		const result = evaluateAlignmentPreflight(
			alignedInput({
				dns: {
					...dns,
					dkimTxt: {
						...dns.dkimTxt,
						'ses-token-1._domainkey.acme.com': found('some unrelated verification string'),
					},
				},
			})
		);
		expect(result.verdict).toBe('blocked');
		expect(result.checks.find((entry) => entry.id === 'dkim')?.remedy).toBe(
			ALIGNMENT_REMEDIES.dkim_missing_record
		);
	});

	it('does not accept a trailing-dot / mixed-case zone as a different domain', () => {
		const result = evaluateAlignmentPreflight(
			alignedInput({
				ownArm: ownArm({ fromDomain: 'ACME.com.', dkimDomain: 'Acme.COM' }),
				dns: alignedDns({
					dkimTxt: {
						'owlat._domainkey.acme.com': found(DKIM_KEY),
						'ses-token-1._domainkey.acme.com': found(DKIM_KEY),
					},
				}),
			})
		);
		expect(result.verdict).toBe('aligned');
	});
});

describe('the gate fails closed on anything that is not fresh evidence', () => {
	it('holds when the pre-flight has never run for a two-armed domain', () => {
		const gate = alignmentGate({ hasReferenceArm: true, state: null, now: CHECKED_AT });
		expect(gate).toEqual({ allowsShareAboveZero: false, reason: 'not_yet_checked' });
		expect(applyAlignmentGateToShare(0.8, gate)).toBe(0);
	});

	it('holds on a stale verdict, even a positive one', () => {
		const gate = alignmentGate({
			hasReferenceArm: true,
			state: { verdict: 'aligned', checkedAt: CHECKED_AT - ALIGNMENT_STALE_AFTER_MS - 1 },
			now: CHECKED_AT,
		});
		expect(gate.reason).toBe('stale');
		expect(gate.allowsShareAboveZero).toBe(false);
	});

	it('holds on a NaN clock rather than treating skew as freshness', () => {
		const gate = alignmentGate({
			hasReferenceArm: true,
			state: { verdict: 'aligned', checkedAt: Number.NaN },
			now: CHECKED_AT,
		});
		expect(gate.allowsShareAboveZero).toBe(false);
	});

	it('accepts a verdict recorded slightly in the future (clock skew forward)', () => {
		const gate = alignmentGate({
			hasReferenceArm: true,
			state: { verdict: 'aligned', checkedAt: CHECKED_AT + 60_000 },
			now: CHECKED_AT,
		});
		expect(gate.allowsShareAboveZero).toBe(true);
	});

	it('distinguishes an unknown hold from a blocked cell', () => {
		expect(
			alignmentGate({
				hasReferenceArm: true,
				state: { verdict: 'unknown', checkedAt: CHECKED_AT },
				now: CHECKED_AT,
			}).reason
		).toBe('unknown_hold');
		expect(
			alignmentGate({
				hasReferenceArm: true,
				state: { verdict: 'blocked', checkedAt: CHECKED_AT },
				now: CHECKED_AT,
			}).reason
		).toBe('blocked');
	});
});
