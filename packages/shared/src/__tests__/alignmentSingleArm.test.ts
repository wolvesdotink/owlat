/**
 * THE D2 PROOF — the additive-only third-party rule, at the single easiest place
 * in the plan to accidentally make an ESP mandatory.
 *
 * With NO reference transport there is no second arm and therefore nothing to
 * align. The pre-flight must pass as "single arm": no error, no block, no
 * warning, no remedy copy, no degraded-measurement nag — and the controller's
 * gate must open WITHOUT a stored verdict, so a deployment with zero
 * third-party accounts is never blocked by a sweep that has not run yet.
 *
 * THE STANDALONE MATRIX: this is not three hand-written cases. It re-runs the
 * ENTIRE four-check failure table from `alignmentFixtures.ts` — every DNS
 * misconfiguration, every timeout, every subdomain trap — with
 * `reference: { kind: 'none' }`, and asserts every single row still passes. A row
 * added to the table is automatically covered here too.
 */

import { describe, expect, it } from 'vitest';
import {
	ALIGNMENT_CHECK_IDS,
	ALIGNMENT_RECHECK_INTERVAL_MS,
	evaluateAlignmentPreflight,
} from '../deliverabilityAlignment';
import {
	ALIGNMENT_STALE_AFTER_MS,
	alignmentGate,
	applyAlignmentGateToShare,
} from '../deliverabilityAlignmentGate';
import { ALIGNMENT_FAILURE_TABLE, alignedInput, CHECKED_AT } from './alignmentFixtures';

const NO_REFERENCE = { kind: 'none' } as const;

describe('the standalone matrix: the whole four-check table with no reference arm', () => {
	for (const testCase of ALIGNMENT_FAILURE_TABLE) {
		it(`passes as single arm even though ${testCase.name}`, () => {
			const result = evaluateAlignmentPreflight({
				...testCase.mutate(alignedInput()),
				reference: NO_REFERENCE,
			});
			expect(result.verdict).toBe('single_arm');
			expect(result.allowsShareAboveZero).toBe(true);
			expect(result.checks.map((check) => check.id)).toEqual([...ALIGNMENT_CHECK_IDS]);
			for (const check of result.checks) {
				expect(check.status).toBe('pass');
				// No remedy copy anywhere: there is nothing for the operator to fix.
				expect(check.remedy).toBe('');
				expect(check.detail).toContain('Single arm');
			}
			// No degraded-measurement nag either.
			expect(result.degradedMeasurement).toBe(false);
			expect(result.degradedMeasurementReason).toBeNull();
			// And the ordinary daily cadence, not the unknown retry.
			expect(result.nextCheckDueAt).toBe(CHECKED_AT + ALIGNMENT_RECHECK_INTERVAL_MS);
		});
	}
});

describe('the gate opens for a standalone deployment regardless of stored state', () => {
	it('opens with no stored verdict at all', () => {
		const gate = alignmentGate({ referenceArm: 'none', state: null, now: CHECKED_AT });
		expect(gate.allowsShareAboveZero).toBe(true);
		expect(gate.reason).toBe('single_arm');
		expect(applyAlignmentGateToShare(1, gate)).toBe(1);
	});

	it('opens even with a stale or blocked leftover row', () => {
		for (const verdict of ['blocked', 'unknown', 'aligned'] as const) {
			const gate = alignmentGate({
				referenceArm: 'none',
				state: { verdict, checkedAt: CHECKED_AT - 10 * ALIGNMENT_STALE_AFTER_MS },
				now: CHECKED_AT,
			});
			expect(gate.allowsShareAboveZero).toBe(true);
			expect(gate.reason).toBe('single_arm');
		}
	});

	it('opens from a stored single_arm verdict even when a relay was later added', () => {
		const gate = alignmentGate({
			referenceArm: 'configured',
			state: { verdict: 'single_arm', checkedAt: CHECKED_AT },
			now: CHECKED_AT,
		});
		expect(gate.allowsShareAboveZero).toBe(true);
		expect(gate.reason).toBe('single_arm');
	});
});
