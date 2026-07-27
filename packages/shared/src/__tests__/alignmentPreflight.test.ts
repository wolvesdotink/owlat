/**
 * The four alignment checks against live-DNS fixtures — each PASSING and each
 * FAILING independently, with the exact remedy text asserted per failure.
 *
 * The failure cases come from the SHARED four-check table in
 * `alignmentFixtures.ts`, which `alignmentSingleArm.test.ts` re-runs verbatim
 * with no reference arm. One table, two suites — the D2 proof cannot drift from
 * the real cases.
 */

import { describe, expect, it } from 'vitest';
import {
	ALIGNMENT_CHECK_IDS,
	ALIGNMENT_RECHECK_INTERVAL_MS,
	ALIGNMENT_UNKNOWN_RETRY_MS,
	evaluateAlignmentPreflight,
	type AlignmentCheckId,
	type AlignmentPreflightResult,
} from '../deliverabilityAlignment';
import { ALIGNMENT_FAILURE_TABLE, alignedInput, CHECKED_AT, relayArm } from './alignmentFixtures';

function check(result: AlignmentPreflightResult, id: AlignmentCheckId) {
	const match = result.checks.find((entry) => entry.id === id);
	if (!match) throw new Error(`no ${id} check in result`);
	return match;
}

describe('the aligned baseline', () => {
	it('passes all four checks and allows a share above zero', () => {
		const result = evaluateAlignmentPreflight(alignedInput());
		expect(result.verdict).toBe('aligned');
		expect(result.checks.map((entry) => entry.id)).toEqual([...ALIGNMENT_CHECK_IDS]);
		for (const id of ALIGNMENT_CHECK_IDS) {
			const entry = check(result, id);
			expect(entry.status).toBe('pass');
			// A passing check carries no remedy — there is nothing to remedy.
			expect(entry.remedy).toBe('');
			expect(entry.detail).not.toBe('');
		}
		expect(result.isMeasurementDegraded).toBe(false);
		expect(result.measurementDegradedReason).toBeNull();
		expect(result.checkedAt).toBe(CHECKED_AT);
		expect(result.nextCheckDueAt).toBe(CHECKED_AT + ALIGNMENT_RECHECK_INTERVAL_MS);
	});
});

describe('each check fails independently, with its own remedy', () => {
	for (const testCase of ALIGNMENT_FAILURE_TABLE) {
		it(`${testCase.check}: ${testCase.name}`, () => {
			const result = evaluateAlignmentPreflight(testCase.mutate(alignedInput()));
			const entry = check(result, testCase.check);
			expect(entry.status).toBe(testCase.expected);
			expect(entry.detail).toContain(testCase.detail);
			expect(entry.remedy).toContain(testCase.remedy);
			expect(result.verdict).toBe(testCase.expected === 'fail' ? 'blocked' : 'unknown');
			expect(result.verdict).toBe(testCase.expected === 'fail' ? 'blocked' : 'unknown');
		});
	}

	it('covers all four checks with at least one failing row each', () => {
		const covered = new Set(ALIGNMENT_FAILURE_TABLE.map((testCase) => testCase.check));
		expect([...covered].sort()).toEqual([...ALIGNMENT_CHECK_IDS].sort());
	});
});

describe('an unresolved lookup is retried sooner than the daily cadence', () => {
	it('schedules the unknown retry, not the daily one', () => {
		const result = evaluateAlignmentPreflight(
			alignedInput({
				dns: {
					fromDomainTxt: { state: 'unknown', failure: 'servfail' },
					dmarcTxt: { state: 'unknown', failure: 'servfail' },
					dkimTxt: {},
				},
			})
		);
		expect(result.verdict).toBe('unknown');
		expect(result.nextCheckDueAt).toBe(CHECKED_AT + ALIGNMENT_UNKNOWN_RETRY_MS);
	});
});

describe('the Return-Path state is recorded, never blocking', () => {
	it('flags degraded measurement without touching the verdict', () => {
		const result = evaluateAlignmentPreflight(
			alignedInput({
				reference: { kind: 'arm', arm: relayArm({ supportsCustomReturnPath: false }) },
			})
		);
		expect(result.verdict).toBe('aligned');
		expect(result.isMeasurementDegraded).toBe(true);
		expect(result.measurementDegradedReason).toContain('the ramp is not blocked');
	});
});

describe('a relay we cannot describe HOLDS, and is never called single arm', () => {
	it('records unknown on every check with a relay-specific remedy', () => {
		const result = evaluateAlignmentPreflight(
			alignedInput({
				reference: {
					kind: 'unknown',
					detail: 'A relay is configured (resend) but acme.com has no verified signing identity.',
				},
			})
		);
		expect(result.verdict).toBe('unknown');
		for (const entry of result.checks) {
			expect(entry.status).toBe('unknown');
			expect(entry.remedy).toContain('Verify the relay for this sending domain');
		}
		expect(result.nextCheckDueAt).toBe(CHECKED_AT + ALIGNMENT_UNKNOWN_RETRY_MS);
	});
});
