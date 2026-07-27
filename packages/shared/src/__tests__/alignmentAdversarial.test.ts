/**
 * Adversarial and degenerate inputs to the alignment pre-flight and its gate.
 *
 * The rules being defended:
 *  - DNS that could not answer is UNKNOWN — never silently "aligned", never a
 *    reported misconfiguration.
 *  - Freshness is bounded in BOTH directions: a verdict from the future is as
 *    unusable as one from two days ago.
 *  - The share boundary sanitises: NaN, Infinity and out-of-range numbers never
 *    travel through an open gate.
 *  - A hostile or empty configuration can never manufacture an `aligned` verdict.
 */

import { describe, expect, it } from 'vitest';
import {
	ALIGNMENT_UNKNOWN_RETRY_MS,
	dkimRecordName,
	evaluateAlignmentPreflight,
	normalizeDomain,
} from '../deliverabilityAlignment';
import {
	ALIGNMENT_MAX_FUTURE_SKEW_MS,
	ALIGNMENT_STALE_AFTER_MS,
	alignmentGate,
	applyAlignmentGateToShare,
} from '../deliverabilityAlignmentGate';
import { alignedDns, alignedInput, CHECKED_AT, found, ownArm, relayArm } from './alignmentFixtures';

describe('DNS that could not answer is UNKNOWN, never aligned', () => {
	for (const failure of ['timeout', 'servfail', 'refused', 'error'] as const) {
		it(`holds on a ${failure} at the From domain`, () => {
			const result = evaluateAlignmentPreflight(
				alignedInput({ dns: alignedDns({ fromDomainTxt: { state: 'unknown', failure } }) })
			);
			expect(result.verdict).toBe('unknown');
			expect(result.nextCheckDueAt).toBe(CHECKED_AT + ALIGNMENT_UNKNOWN_RETRY_MS);
		});
	}

	it('treats a MISSING DKIM observation as unknown, not as an absent record', () => {
		const result = evaluateAlignmentPreflight(alignedInput({ dns: alignedDns({ dkimTxt: {} }) }));
		expect(result.verdict).toBe('unknown');
	});

	it('reports a fail ahead of an unknown when both arms have problems', () => {
		const result = evaluateAlignmentPreflight(
			alignedInput({
				dns: alignedDns({
					dkimTxt: {
						'owlat._domainkey.acme.com': { state: 'absent' },
						'ses-token-1._domainkey.acme.com': { state: 'unknown', failure: 'timeout' },
					},
				}),
			})
		);
		const dkim = result.checks.find((check) => check.id === 'dkim');
		expect(dkim?.status).toBe('fail');
		expect(result.verdict).toBe('blocked');
	});
});

describe('degenerate configurations never manufacture an aligned verdict', () => {
	it('fails an empty own From domain rather than matching an empty relay one', () => {
		const result = evaluateAlignmentPreflight(
			alignedInput({
				ownArm: ownArm({ fromDomain: '   ' }),
				reference: { kind: 'arm', arm: relayArm({ fromDomain: '' }) },
			})
		);
		expect(result.checks.find((check) => check.id === 'from_domain')?.status).toBe('fail');
		expect(result.verdict).toBe('blocked');
	});

	it('fails an arm with no selectors at all instead of finding zero collisions', () => {
		const result = evaluateAlignmentPreflight(
			alignedInput({ ownArm: ownArm({ dkimSelectors: [] }) })
		);
		const dkim = result.checks.find((check) => check.id === 'dkim');
		expect(dkim?.status).toBe('fail');
		expect(dkim?.detail).toContain('(no selector configured)');
	});

	it('does not accept a TXT record that merely mentions DKIM', () => {
		const result = evaluateAlignmentPreflight(
			alignedInput({
				dns: alignedDns({
					dkimTxt: {
						'owlat._domainkey.acme.com': found('this is not a dkim key'),
						'ses-token-1._domainkey.acme.com': found('v=DKIM1; k=rsa; p=AAAA'),
					},
				}),
			})
		);
		expect(result.checks.find((check) => check.id === 'dkim')?.status).toBe('fail');
	});

	it('does not accept an SPF-shaped snapshot crafted to force a pass', () => {
		// A record that authorizes the whole internet still has to carry both arms'
		// mechanisms — `+all` is not an alignment proof.
		const result = evaluateAlignmentPreflight(
			alignedInput({ dns: alignedDns({ fromDomainTxt: found('v=spf1 +all') }) })
		);
		expect(result.checks.find((check) => check.id === 'spf')?.status).toBe('fail');
	});
});

describe('the DNS-name helpers are one implementation', () => {
	it('normalizes case and the trailing root dot', () => {
		expect(normalizeDomain('  ACME.com.  ')).toBe('acme.com');
		expect(dkimRecordName(' OWLAT ', 'ACME.com.')).toBe('owlat._domainkey.acme.com');
	});
});

describe('gate freshness is bounded in both directions', () => {
	it('accepts a verdict inside the stale window', () => {
		const gate = alignmentGate({
			referenceArm: 'configured',
			state: { verdict: 'aligned', checkedAt: CHECKED_AT - ALIGNMENT_STALE_AFTER_MS + 1 },
			now: CHECKED_AT,
		});
		expect(gate.allowsShareAboveZero).toBe(true);
	});

	it('rejects a verdict older than the stale window', () => {
		const gate = alignmentGate({
			referenceArm: 'configured',
			state: { verdict: 'aligned', checkedAt: CHECKED_AT - ALIGNMENT_STALE_AFTER_MS - 1 },
			now: CHECKED_AT,
		});
		expect(gate.allowsShareAboveZero).toBe(false);
		expect(gate.reason).toBe('stale');
	});

	it('accepts a verdict slightly in the future (tolerated clock skew)', () => {
		const gate = alignmentGate({
			referenceArm: 'configured',
			state: { verdict: 'aligned', checkedAt: CHECKED_AT + ALIGNMENT_MAX_FUTURE_SKEW_MS },
			now: CHECKED_AT,
		});
		expect(gate.allowsShareAboveZero).toBe(true);
	});

	it('REJECTS a verdict far in the future — a skewed clock must not pin `aligned`', () => {
		for (const ahead of [ALIGNMENT_MAX_FUTURE_SKEW_MS + 1, 48 * 60 * 60 * 1000, 1e15]) {
			const gate = alignmentGate({
				referenceArm: 'configured',
				state: { verdict: 'aligned', checkedAt: CHECKED_AT + ahead },
				now: CHECKED_AT,
			});
			expect(gate.allowsShareAboveZero).toBe(false);
			expect(gate.reason).toBe('stale');
		}
	});

	it('holds on a NaN or infinite clock rather than treating skew as freshness', () => {
		for (const checkedAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			const gate = alignmentGate({
				referenceArm: 'configured',
				state: { verdict: 'aligned', checkedAt },
				now: CHECKED_AT,
			});
			expect(gate.allowsShareAboveZero).toBe(false);
			expect(gate.reason).toBe('stale');
		}
	});
});

describe('the gate distinguishes its hold reasons', () => {
	it('separates unknown, blocked, not-yet-checked and an undescribed relay', () => {
		expect(
			alignmentGate({
				referenceArm: 'configured',
				state: { verdict: 'unknown', checkedAt: CHECKED_AT },
				now: CHECKED_AT,
			}).reason
		).toBe('unknown_hold');
		expect(
			alignmentGate({
				referenceArm: 'configured',
				state: { verdict: 'blocked', checkedAt: CHECKED_AT },
				now: CHECKED_AT,
			}).reason
		).toBe('blocked');
		expect(alignmentGate({ referenceArm: 'configured', state: null, now: CHECKED_AT }).reason).toBe(
			'not_yet_checked'
		);
		const undescribed = alignmentGate({
			referenceArm: 'unknown',
			state: { verdict: 'aligned', checkedAt: CHECKED_AT },
			now: CHECKED_AT,
		});
		expect(undescribed.reason).toBe('reference_arm_unknown');
		expect(undescribed.allowsShareAboveZero).toBe(false);
	});
});

describe('applyAlignmentGateToShare sanitises the share at the boundary', () => {
	const open = { allowsShareAboveZero: true, reason: 'aligned' } as const;
	const shut = { allowsShareAboveZero: false, reason: 'blocked' } as const;

	it('pins every proposal at 0 through a shut gate', () => {
		for (const share of [0, 0.5, 1, 1.7, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(applyAlignmentGateToShare(share, shut)).toBe(0);
		}
	});

	it('clamps an out-of-range proposal through an open gate', () => {
		expect(applyAlignmentGateToShare(1.7, open)).toBe(1);
		expect(applyAlignmentGateToShare(-0.5, open)).toBe(0);
		expect(applyAlignmentGateToShare(0.42, open)).toBe(0.42);
		expect(applyAlignmentGateToShare(0, open)).toBe(0);
		expect(applyAlignmentGateToShare(1, open)).toBe(1);
	});

	it('maps a non-finite proposal to 0 rather than letting it through', () => {
		for (const share of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(applyAlignmentGateToShare(share, open)).toBe(0);
		}
	});
});
