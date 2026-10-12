/**
 * The admission rule (ADR-0073, Phase 1b, D1 and D4), pure: the ceiling, the
 * triage allowance, the advisory reserve, the per-plane capacity and the
 * shadow allowance, each at its boundary.
 */

import { describe, expect, it } from 'vitest';
import {
	emptyUsage,
	evaluateAdmission,
	PLANE_CAPACITY_FRACTION,
	type AdmissionLimits,
	type AdmissionRequestShape,
	type PeriodUsage,
} from '../admissionRules';
import { shadowSample, shadowSamplePoint, isTaskShadowed } from '../shadowSampling';
import { resolveRoutingPolicy } from '@owlat/shared/aiRouting';

const USD = 1_000_000;

const limits = (over: Partial<AdmissionLimits> = {}): AdmissionLimits => ({
	dailyCeilingMicrousd: 10 * USD,
	monthlyCeilingMicrousd: 0,
	triageAllowanceFraction: 0.1,
	advisoryReserveFraction: 0.2,
	shadowAllowanceMicrousd: 0,
	...over,
});

const request = (over: Partial<AdmissionRequestShape> = {}): AdmissionRequestShape => ({
	plane: 'language',
	budgetClass: 'standard',
	priority: 'pipeline',
	microusd: 1,
	...over,
});

/** A day with `standard` settled language spend and nothing else. */
function day(standardUsd: number, extra: (usage: PeriodUsage) => void = () => {}) {
	const usage = emptyUsage();
	usage.settled.language.standard = Math.round(standardUsd * USD);
	extra(usage);
	return { day: usage, month: emptyUsage() };
}

describe('evaluateAdmission', () => {
	it('admits anything with no ceiling configured, except shadow traffic', () => {
		const none = limits({ dailyCeilingMicrousd: 0 });
		expect(evaluateAdmission(none, day(1_000), request({ microusd: 50 * USD }))).toEqual({
			isAdmitted: true,
		});
		expect(evaluateAdmission(none, day(0), request({ budgetClass: 'shadow' }))).toMatchObject({
			isAdmitted: false,
			limit: 'shadow_allowance',
		});
	});

	it('refuses a call whose hold would cross the ceiling, counting outstanding holds', () => {
		// $8.8 settled + $0.1 held: standard work may reach $9 (10 less the $1
		// triage allowance nobody has used yet).
		const usage = day(8.8, (u) => {
			u.held.language.standard = 0.1 * USD;
		});
		expect(evaluateAdmission(limits(), usage, request({ microusd: 0.1 * USD }))).toEqual({
			isAdmitted: true,
		});
		expect(evaluateAdmission(limits(), usage, request({ microusd: 0.1 * USD + 1 }))).toMatchObject({
			isAdmitted: false,
			reason: 'daily_ceiling',
			limit: 'triage_allowance',
		});
		// Without the held $0.1 the same call fits: holds count against headroom.
		expect(evaluateAdmission(limits(), day(8.8), request({ microusd: 0.1 * USD + 1 }))).toEqual({
			isAdmitted: true,
		});
	});

	it('lets triage use its allowance and any headroom left, but not past the ceiling', () => {
		const usage = day(9);
		const triage = request({ budgetClass: 'triage' });
		expect(evaluateAdmission(limits(), usage, { ...triage, microusd: USD })).toEqual({
			isAdmitted: true,
		});
		expect(evaluateAdmission(limits(), usage, { ...triage, microusd: USD + 1 })).toMatchObject({
			isAdmitted: false,
			limit: 'ceiling',
		});
	});

	it('gives the unused triage allowance back to standard work as triage spends it', () => {
		const spentTriage = day(8.5, (u) => {
			u.settled.language.triage = 1 * USD;
		});
		// Triage used its whole $1: standard may now reach the ceiling.
		expect(evaluateAdmission(limits(), spentTriage, request({ microusd: 0.5 * USD }))).toEqual({
			isAdmitted: true,
		});
	});

	it('keeps the advisory reserve for the pipeline: interactive and background stop earlier', () => {
		// $6.9 settled; reserve $2, triage unused $1: interactive may reach $7.
		const usage = day(6.9);
		expect(
			evaluateAdmission(limits(), usage, request({ priority: 'interactive', microusd: 0.1 * USD }))
		).toEqual({ isAdmitted: true });
		expect(
			evaluateAdmission(limits(), usage, request({ priority: 'background', microusd: 0.2 * USD }))
		).toMatchObject({ isAdmitted: false, limit: 'advisory_reserve' });
		expect(
			evaluateAdmission(limits(), usage, request({ priority: 'pipeline', microusd: 0.2 * USD }))
		).toEqual({ isAdmitted: true });
	});

	it('caps the decision and embedding planes at their share, so they cannot eat the writer budget', () => {
		const cap = PLANE_CAPACITY_FRACTION.decision * 10 * USD;
		const usage = day(0, (u) => {
			u.settled.decision.triage = cap - 10;
		});
		const decision = request({ plane: 'decision', budgetClass: 'triage' });
		expect(evaluateAdmission(limits(), usage, { ...decision, microusd: 10 })).toEqual({
			isAdmitted: true,
		});
		expect(evaluateAdmission(limits(), usage, { ...decision, microusd: 11 })).toMatchObject({
			isAdmitted: false,
			limit: 'plane_capacity',
		});
		// The language plane is untouched by the decision plane's cap.
		expect(evaluateAdmission(limits(), usage, request({ microusd: USD }))).toEqual({
			isAdmitted: true,
		});
	});

	it('checks the month as well as the day', () => {
		const usage = { day: emptyUsage(), month: emptyUsage() };
		usage.month.settled.language.standard = 99 * USD;
		expect(
			evaluateAdmission(
				limits({ monthlyCeilingMicrousd: 100 * USD }),
				usage,
				request({ microusd: 2 * USD })
			)
		).toMatchObject({ isAdmitted: false, reason: 'monthly_ceiling' });
	});

	it('holds shadow traffic to the day’s shadow allowance, with or without a ceiling', () => {
		const shadow = request({ budgetClass: 'shadow', priority: 'background' });
		const usage = day(0, (u) => {
			u.settled.decision.shadow = 0.4 * USD;
			u.held.language.shadow = 0.05 * USD;
		});
		const withAllowance = limits({ dailyCeilingMicrousd: 0, shadowAllowanceMicrousd: 0.5 * USD });
		expect(evaluateAdmission(withAllowance, usage, { ...shadow, microusd: 0.05 * USD })).toEqual({
			isAdmitted: true,
		});
		expect(
			evaluateAdmission(withAllowance, usage, { ...shadow, microusd: 0.05 * USD + 1 })
		).toMatchObject({ isAdmitted: false, limit: 'shadow_allowance' });
	});

	it('refuses an amount that is not a non-negative integer', () => {
		expect(evaluateAdmission(limits(), day(0), request({ microusd: 1.5 }))).toMatchObject({
			isAdmitted: false,
			reason: 'spend_unverifiable',
		});
	});
});

describe('shadow sampling (D4)', () => {
	const shadowed = resolveRoutingPolicy({
		policyVersion: 1,
		updatedAt: 1,
		updatedBy: 'admin',
		categoryDisplayBundle: 'shadow',
	} as never);

	it('shadows nothing while the task’s switch is off (the default)', () => {
		const policy = resolveRoutingPolicy(null);
		expect(isTaskShadowed(policy, 'mail.category')).toBe(false);
		expect(shadowSample(policy, 'mail.category', 'msg-1')).toEqual({
			isSampled: false,
			why: 'not_shadowed',
		});
	});

	it('picks a stable set of candidates at twice the message share (the quota caps the admitted)', () => {
		expect(isTaskShadowed(shadowed, 'mail.category')).toBe(true);
		expect(isTaskShadowed(shadowed, 'mail.disposition')).toBe(false);
		let candidates = 0;
		const total = 20_000;
		for (let index = 0; index < total; index++) {
			const key = `inbound-${index}`;
			const verdict = shadowSample(shadowed, 'mail.category', key);
			// Deterministic: the same message is always a candidate or never.
			expect(shadowSample(shadowed, 'mail.category', key)).toEqual(verdict);
			if (verdict.isSampled) candidates++;
		}
		expect(candidates / total).toBeGreaterThan(0.18);
		expect(candidates / total).toBeLessThan(0.22);
		expect(shadowSamplePoint('mail.category', 'x')).toBeGreaterThanOrEqual(0);
		expect(shadowSamplePoint('mail.category', 'x')).toBeLessThan(1);
	});
});
