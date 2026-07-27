/**
 * THE D2 PROOF — the additive-only third-party rule, at the single easiest place
 * in the plan to accidentally make an ESP mandatory.
 *
 * With NO reference transport there is no second arm and therefore nothing to
 * align. The pre-flight must pass as "single arm": no error, no block, no
 * warning, no remedy copy, no degraded-measurement nag — and the controller's
 * gate must open WITHOUT a stored verdict, so a deployment with zero
 * third-party accounts is never blocked by a sweep that has not run yet.
 */

import { describe, expect, it } from 'vitest';
import {
	ALIGNMENT_CHECK_IDS,
	ALIGNMENT_RECHECK_INTERVAL_MS,
	ALIGNMENT_STALE_AFTER_MS,
	alignmentGate,
	applyAlignmentGateToShare,
	evaluateAlignmentPreflight,
} from '../deliverabilityAlignment';
import { alignedDns, alignedInput, CHECKED_AT } from './alignmentFixtures';

describe('no reference transport — the check passes trivially as "single arm"', () => {
	const result = evaluateAlignmentPreflight(alignedInput({ referenceArm: null }));

	it('reports single_arm and allows the ramp', () => {
		expect(result.verdict).toBe('single_arm');
		expect(result.allowsShareAboveZero).toBe(true);
	});

	it('reports every check as a pass, with no remedy and no failure', () => {
		expect(result.checks.map((entry) => entry.id)).toEqual([...ALIGNMENT_CHECK_IDS]);
		expect(result.checks.every((entry) => entry.status === 'pass')).toBe(true);
		expect(result.checks.every((entry) => entry.remedy === '')).toBe(true);
		expect(result.checks.some((entry) => entry.status === 'fail')).toBe(false);
		expect(result.checks.some((entry) => entry.status === 'unknown')).toBe(false);
	});

	it('never flags degraded measurement for the absent arm', () => {
		expect(result.degradedMeasurement).toBe(false);
		expect(result.degradedMeasurementReason).toBeNull();
	});

	it('still re-checks on the ordinary daily cadence', () => {
		expect(result.nextCheckDueAt).toBe(CHECKED_AT + ALIGNMENT_RECHECK_INTERVAL_MS);
	});

	it('says "single arm" in plain language rather than naming a fault', () => {
		for (const entry of result.checks) {
			expect(entry.detail).toContain('Single arm');
			expect(entry.detail.toLowerCase()).not.toContain('error');
		}
	});
});

describe('single arm holds even when the domain DNS is a disaster', () => {
	it('does not turn an unresolved or empty zone into a failure', () => {
		const result = evaluateAlignmentPreflight(
			alignedInput({
				referenceArm: null,
				dns: alignedDns({
					fromDomainTxt: { state: 'unknown', failure: 'servfail' },
					dmarcTxt: { state: 'absent' },
					dkimTxt: {},
				}),
			})
		);
		expect(result.verdict).toBe('single_arm');
		expect(result.allowsShareAboveZero).toBe(true);
	});
});

describe('the controller gate never depends on a stored verdict when there is one arm', () => {
	it('opens with no stored state at all', () => {
		const gate = alignmentGate({ hasReferenceArm: false, state: null, now: CHECKED_AT });
		expect(gate).toEqual({ allowsShareAboveZero: true, reason: 'single_arm' });
		expect(applyAlignmentGateToShare(0.25, gate)).toBe(0.25);
	});

	it('opens even when a stale blocked verdict is still on the row', () => {
		const gate = alignmentGate({
			hasReferenceArm: false,
			state: { verdict: 'blocked', checkedAt: CHECKED_AT - ALIGNMENT_STALE_AFTER_MS * 3 },
			now: CHECKED_AT,
		});
		expect(gate.allowsShareAboveZero).toBe(true);
		expect(gate.reason).toBe('single_arm');
	});

	it('opens on a recorded single_arm verdict regardless of age', () => {
		const gate = alignmentGate({
			hasReferenceArm: true,
			state: { verdict: 'single_arm', checkedAt: CHECKED_AT - ALIGNMENT_STALE_AFTER_MS * 5 },
			now: CHECKED_AT,
		});
		expect(gate.allowsShareAboveZero).toBe(true);
	});
});
