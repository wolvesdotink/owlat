import { describe, it, expect } from 'vitest';
import {
	evaluateSunset,
	isSunsetPolicyValid,
	resolveSunsetPolicy,
	SUNSET_POLICY_DEFAULTS,
	type SunsetVerdict,
} from '../sunsetPolicy';
import { daysAgo, facts, measured, policy } from './sunsetFixtures';

/**
 * The N/M thresholds, per topic, across the five states a contact can be in
 * (deliverability plan P4-4): engaged, quiet-then-re-engaged, quiet past N,
 * quiet past M, and an operator override at each stage.
 */

function verdict(overrides: Parameters<typeof facts>[0], p = policy()): SunsetVerdict {
	return evaluateSunset(facts(overrides), p);
}

describe('evaluateSunset — the threshold table', () => {
	it('holds an engaged contact on the normal track', () => {
		const v = verdict({ lastEngagementAt: daysAgo(10) });
		expect(v.action).toBe('hold');
		expect(v.stage).toBe('engaged');
		expect(v.reason).toBe('engaged_recently');
	});

	it('holds just inside the re-engagement window', () => {
		const v = verdict({ lastEngagementAt: daysAgo(179) });
		expect(v.action).toBe('hold');
		expect(v.reason).toBe('engaged_recently');
	});

	it('moves a contact quiet past N onto the re-engagement track', () => {
		const v = verdict({ lastEngagementAt: daysAgo(181) });
		expect(v.action).toBe('enter_reengagement');
		expect(v.stage).toBe('reengagement');
		expect(v.reason).toBe('quiet_past_reengage_window');
		expect(Math.round(measured(v).quietDays)).toBe(181);
	});

	it('holds a contact already on the re-engagement track and still quiet', () => {
		const v = verdict({ lastEngagementAt: daysAgo(200), stage: 'reengagement' });
		expect(v.action).toBe('hold');
		expect(v.stage).toBe('reengagement');
		expect(v.reason).toBe('quiet_past_reengage_window');
	});

	it('resumes a re-engagement-track contact that engaged again', () => {
		const v = verdict({ lastEngagementAt: daysAgo(3), stage: 'reengagement' });
		expect(v.action).toBe('resume');
		expect(v.stage).toBe('engaged');
		expect(v.reason).toBe('engaged_recently');
	});

	it('suppresses a contact quiet past M', () => {
		const v = verdict({ lastEngagementAt: daysAgo(280), stage: 'reengagement' });
		expect(v.action).toBe('suppress');
		expect(v.stage).toBe('suppressed');
		expect(v.reason).toBe('quiet_past_suppress_window');
	});

	it('suppresses straight from engaged when the sweep first sees a very old contact', () => {
		const v = verdict({ lastEngagementAt: daysAgo(365) });
		expect(v.action).toBe('suppress');
	});

	it('never auto-resurrects a suppressed contact, even on fresh engagement', () => {
		const v = verdict({ lastEngagementAt: daysAgo(1), stage: 'suppressed' });
		expect(v.action).toBe('hold');
		expect(v.stage).toBe('suppressed');
	});

	it('holds a suppressed contact that is still quiet', () => {
		const v = verdict({ lastEngagementAt: daysAgo(400), stage: 'suppressed' });
		expect(v.action).toBe('hold');
		expect(v.reason).toBe('already_suppressed');
	});

	it('holds when the address is already on the blocklist for another reason', () => {
		const v = verdict({ lastEngagementAt: daysAgo(400), isAlreadySuppressed: true });
		expect(v.action).toBe('hold');
		expect(v.reason).toBe('already_suppressed');
	});

	it('measures quiet time from the first send when the contact never engaged', () => {
		const v = verdict({ firstMessagedAt: daysAgo(300), lastEngagementAt: undefined });
		expect(v.action).toBe('suppress');
		expect(Math.round(measured(v).quietDays)).toBe(300);
	});
});

describe('evaluateSunset — the operator override at every stage', () => {
	for (const stage of ['engaged', 'reengagement', 'suppressed'] as const) {
		it(`holds an exempt contact in stage ${stage}`, () => {
			const v = verdict({ stage, isExempt: true, lastEngagementAt: daysAgo(999) });
			expect(v.action).toBe('hold');
			expect(v.reason).toBe('operator_override');
			expect(v.stage).toBe(stage);
		});
	}

	it('holds every stage when the policy is disabled', () => {
		const v = verdict({ lastEngagementAt: daysAgo(999) }, policy({ isEnabled: false }));
		expect(v.action).toBe('hold');
		expect(v.reason).toBe('policy_disabled');
	});
});

describe('evaluateSunset — per-topic thresholds', () => {
	it('applies a tighter topic policy', () => {
		const tight = policy({ reengageAfterDays: 60, suppressAfterDays: 90 });
		expect(verdict({ lastEngagementAt: daysAgo(70) }, tight).action).toBe('enter_reengagement');
		expect(verdict({ lastEngagementAt: daysAgo(100) }, tight).action).toBe('suppress');
	});

	it('applies a looser topic policy', () => {
		const loose = policy({ reengageAfterDays: 365, suppressAfterDays: 540 });
		expect(verdict({ lastEngagementAt: daysAgo(300) }, loose).action).toBe('hold');
	});
});

describe('resolveSunsetPolicy', () => {
	it('returns the shipped default when nothing is configured', () => {
		expect(resolveSunsetPolicy({})).toEqual({ ...SUNSET_POLICY_DEFAULTS });
	});

	it('layers a deployment-wide override onto the default', () => {
		expect(resolveSunsetPolicy({ globalOverride: { reengageAfterDays: 90 } })).toEqual({
			isEnabled: true,
			reengageAfterDays: 90,
			suppressAfterDays: 270,
		});
	});

	it('inherits every field an override leaves absent', () => {
		expect(resolveSunsetPolicy({ globalOverride: {} })).toEqual({ ...SUNSET_POLICY_DEFAULTS });
	});

	it('takes the MOST LENIENT combination across a contact’s topics', () => {
		const resolved = resolveSunsetPolicy({
			topicOverrides: [
				{ reengageAfterDays: 60, suppressAfterDays: 90 },
				{ reengageAfterDays: 200, suppressAfterDays: 400 },
			],
		});
		expect(resolved.reengageAfterDays).toBe(200);
		expect(resolved.suppressAfterDays).toBe(400);
	});

	it('one topic opting out disables sunsetting for the whole contact', () => {
		const resolved = resolveSunsetPolicy({
			topicOverrides: [{ isEnabled: false }, { isEnabled: true }],
		});
		expect(resolved.isEnabled).toBe(false);
	});

	it('ignores a non-positive or non-finite override value', () => {
		const resolved = resolveSunsetPolicy({
			globalOverride: { reengageAfterDays: 0, suppressAfterDays: Number.NaN },
		});
		expect(resolved).toEqual({ ...SUNSET_POLICY_DEFAULTS });
	});
});

describe('isSunsetPolicyValid', () => {
	it('accepts the shipped default', () => {
		expect(isSunsetPolicyValid({ ...SUNSET_POLICY_DEFAULTS })).toBe(true);
	});

	it('rejects a backwards window pair', () => {
		expect(
			isSunsetPolicyValid({ isEnabled: true, reengageAfterDays: 300, suppressAfterDays: 100 })
		).toBe(false);
	});

	it('rejects a window below the floor', () => {
		expect(
			isSunsetPolicyValid({ isEnabled: true, reengageAfterDays: 1, suppressAfterDays: 2 })
		).toBe(false);
	});

	it('holds rather than guessing on an invalid policy', () => {
		const v = verdict(
			{ lastEngagementAt: daysAgo(999) },
			{ isEnabled: true, reengageAfterDays: 300, suppressAfterDays: 100 }
		);
		expect(v.action).toBe('hold');
		expect(v.reason).toBe('invalid_policy');
	});
});
