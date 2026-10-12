import { describe, expect, it } from 'vitest';
import {
	AI_TASK_NAMES,
	isAiTaskName,
	resolveRoutingPolicy,
	ROUTING_CAP_MAX,
	ROUTING_SWITCH_KEYS,
	ROUTING_SWITCHES,
	routingPolicyProblem,
	SHADOW_FRACTION_MAXIMA,
	shadowAllowanceUsd,
	shadowedSwitches,
	type RoutingPolicyRow,
} from '../aiRouting';

const NO_CEILING = { dailyCeilingUsd: 0 };
const TEN_A_DAY = { dailyCeilingUsd: 10 };

describe('the default routing policy is today’s behaviour', () => {
	it('a missing row switches every new path off and caps nothing', () => {
		const policy = resolveRoutingPolicy(null);
		for (const key of ROUTING_SWITCH_KEYS) expect(policy[key], key).toBe('off');
		expect(policy).toMatchObject({
			policyVersion: 0,
			knowledgeEntryCapPerMessage: null,
			verifyClaimCapPerMessage: null,
			promptCacheTasks: [],
			triageAllowanceFraction: 0.1,
			shadowMaxMessageFraction: 0.1,
			shadowMaxCeilingFraction: 0.05,
			shadowCapUsd: null,
			updatedAt: null,
		});
		expect(shadowedSwitches(policy)).toEqual([]);
	});

	it('an empty stored row reads exactly like no row', () => {
		expect(resolveRoutingPolicy({})).toEqual(resolveRoutingPolicy(undefined));
	});

	it('every switch default is its off value, the first value it lists', () => {
		for (const key of ROUTING_SWITCH_KEYS) {
			const spec = ROUTING_SWITCHES[key];
			expect(spec.defaultValue, key).toBe(spec.values[0]);
			expect(spec.values[0], key).toBe('off');
		}
	});
});

describe('resolveRoutingPolicy', () => {
	it('reads the stored values', () => {
		const policy = resolveRoutingPolicy({
			policyVersion: 4,
			categoryDisplayBundle: 'shadow',
			cheapFirstWriter: 'reviewed',
			knowledgeEntryCapPerMessage: 12,
			verifyClaimCapPerMessage: 9,
			promptCacheTasks: ['mail.draft', 'mail.classify'],
			triageAllowanceFraction: 0.2,
			shadowCapUsd: 3,
			updatedAt: 123,
		});
		expect(policy).toMatchObject({
			policyVersion: 4,
			categoryDisplayBundle: 'shadow',
			cheapFirstWriter: 'reviewed',
			knowledgeEntryCapPerMessage: 12,
			verifyClaimCapPerMessage: 9,
			promptCacheTasks: ['mail.draft', 'mail.classify'],
			triageAllowanceFraction: 0.2,
			shadowCapUsd: 3,
			updatedAt: 123,
		});
		expect(shadowedSwitches(policy)).toEqual(['categoryDisplayBundle']);
	});

	it('never lets a value it does not recognise switch a path on', () => {
		const policy = resolveRoutingPolicy({
			policyVersion: -3,
			triageBundle: 'enforce',
			earlyRuleArchive: 'sometimes',
			knowledgeEntryCapPerMessage: 0,
			verifyClaimCapPerMessage: 2.5,
			promptCacheTasks: ['mail.draft', 'not.a.task', 'mail.draft'],
			triageAllowanceFraction: 1,
			shadowMaxMessageFraction: Number.NaN,
			shadowMaxCeilingFraction: -0.1,
			shadowCapUsd: 0,
		});
		expect(policy).toMatchObject({
			policyVersion: 0,
			triageBundle: 'off',
			earlyRuleArchive: 'off',
			knowledgeEntryCapPerMessage: null,
			verifyClaimCapPerMessage: null,
			promptCacheTasks: ['mail.draft'],
			triageAllowanceFraction: 0.1,
			shadowMaxMessageFraction: 0.1,
			shadowMaxCeilingFraction: 0.05,
			shadowCapUsd: null,
		});
	});
});

describe('shadowAllowanceUsd (D4)', () => {
	const shadowing = resolveRoutingPolicy({ triageBundle: 'shadow' });

	it('is zero while nothing is shadowed', () => {
		expect(shadowAllowanceUsd(resolveRoutingPolicy(null), 100)).toBe(0);
	});

	it('is the ceiling share when only a daily ceiling bounds it', () => {
		expect(shadowAllowanceUsd(shadowing, 100)).toBeCloseTo(5);
	});

	it('takes the smaller of the ceiling share and the explicit cap', () => {
		expect(shadowAllowanceUsd({ ...shadowing, shadowCapUsd: 2 }, 100)).toBe(2);
		expect(shadowAllowanceUsd({ ...shadowing, shadowCapUsd: 20 }, 100)).toBeCloseTo(5);
	});

	it('needs the explicit cap without a daily ceiling, and is zero without either', () => {
		expect(shadowAllowanceUsd({ ...shadowing, shadowCapUsd: 1.5 }, 0)).toBe(1.5);
		expect(shadowAllowanceUsd(shadowing, 0)).toBe(0);
	});
});

describe('D4 shadow maxima', () => {
	it('are 10% of messages and 5% of the daily ceiling, and the defaults', () => {
		expect(SHADOW_FRACTION_MAXIMA).toEqual({
			shadowMaxMessageFraction: 0.1,
			shadowMaxCeilingFraction: 0.05,
		});
		const policy = resolveRoutingPolicy(null);
		expect(policy.shadowMaxMessageFraction).toBe(0.1);
		expect(policy.shadowMaxCeilingFraction).toBe(0.05);
	});

	it.each<[string, RoutingPolicyRow, boolean]>([
		['the message maximum itself', { shadowMaxMessageFraction: 0.1 }, true],
		['the ceiling maximum itself', { shadowMaxCeilingFraction: 0.05 }, true],
		['a lower message share', { shadowMaxMessageFraction: 0.02 }, true],
		['a lower ceiling share', { shadowMaxCeilingFraction: 0.01 }, true],
		['just above the message maximum', { shadowMaxMessageFraction: 0.1000001 }, false],
		['just above the ceiling maximum', { shadowMaxCeilingFraction: 0.0500001 }, false],
		['a message share of 0.9', { shadowMaxMessageFraction: 0.9 }, false],
		['a ceiling share of 0.9', { shadowMaxCeilingFraction: 0.9 }, false],
	])('validation: %s', (_label, row, isValid) => {
		expect(routingPolicyProblem(row, TEN_A_DAY) === null).toBe(isValid);
	});

	it('keeps a share within its maximum and reads one above it as the default', () => {
		expect(
			resolveRoutingPolicy({ shadowMaxMessageFraction: 0.03, shadowMaxCeilingFraction: 0.02 })
		).toMatchObject({ shadowMaxMessageFraction: 0.03, shadowMaxCeilingFraction: 0.02 });
		expect(
			resolveRoutingPolicy({ shadowMaxMessageFraction: 0.9, shadowMaxCeilingFraction: 0.9 })
		).toMatchObject({ shadowMaxMessageFraction: 0.1, shadowMaxCeilingFraction: 0.05 });
	});

	it('never lets a stored 0.9 share spend more than 5% of the daily ceiling', () => {
		const policy = resolveRoutingPolicy({
			triageBundle: 'shadow',
			shadowMaxMessageFraction: 0.9,
			shadowMaxCeilingFraction: 0.9,
		});
		expect(shadowAllowanceUsd(policy, 100)).toBeCloseTo(5);
	});
});

describe('routingPolicyProblem', () => {
	const valid: RoutingPolicyRow = {
		claimVerification: 'enforce',
		triageAllowanceFraction: 0.25,
		knowledgeEntryCapPerMessage: ROUTING_CAP_MAX,
		promptCacheTasks: ['mail.draft'],
	};

	it('accepts a valid policy and the empty one', () => {
		expect(routingPolicyProblem(valid, NO_CEILING)).toBeNull();
		expect(routingPolicyProblem({}, NO_CEILING)).toBeNull();
	});

	it.each<[string, RoutingPolicyRow]>([
		['a value a switch does not take', { triageBundle: 'enforce' }],
		['a fraction of 0', { triageAllowanceFraction: 0 }],
		['a fraction of 1', { shadowMaxMessageFraction: 1 }],
		['a non-finite fraction', { shadowMaxCeilingFraction: Number.POSITIVE_INFINITY }],
		['a zero shadow cap', { shadowCapUsd: 0 }],
		['a negative shadow cap', { shadowCapUsd: -1 }],
		['a fractional cap', { verifyClaimCapPerMessage: 1.5 }],
		['a cap above the bound', { knowledgeEntryCapPerMessage: ROUTING_CAP_MAX + 1 }],
		['an unknown cache task', { promptCacheTasks: ['mail.nope'] }],
		['a repeated cache task', { promptCacheTasks: ['mail.draft', 'mail.draft'] }],
	])('refuses %s', (_label, row) => {
		expect(routingPolicyProblem(row, TEN_A_DAY)).toEqual(expect.any(String));
	});

	it('refuses shadowing without a daily ceiling unless a shadow cap is set', () => {
		expect(routingPolicyProblem({ clarifyNecessity: 'shadow' }, NO_CEILING)).toMatch(/shadow/);
		expect(
			routingPolicyProblem({ clarifyNecessity: 'shadow', shadowCapUsd: 1 }, NO_CEILING)
		).toBeNull();
		expect(routingPolicyProblem({ clarifyNecessity: 'shadow' }, TEN_A_DAY)).toBeNull();
	});
});

describe('task names', () => {
	it('are unique and recognised', () => {
		expect(new Set(AI_TASK_NAMES).size).toBe(AI_TASK_NAMES.length);
		for (const name of AI_TASK_NAMES) expect(isAiTaskName(name)).toBe(true);
		expect(isAiTaskName('mail.unknown')).toBe(false);
	});

	it('include the plan’s names', () => {
		for (const name of [
			'mail.classify',
			'mail.extract',
			'mail.verify',
			'mail.clarify',
			'mail.draft',
			'assistant.answer',
		]) {
			expect(isAiTaskName(name), name).toBe(true);
		}
	});

	it('name a shadowable switch’s task for every switch that can shadow', () => {
		for (const key of ROUTING_SWITCH_KEYS) {
			const spec: { values: readonly string[]; task?: string } = ROUTING_SWITCHES[key];
			if (spec.values.includes('shadow')) expect(spec.task, key).toBeDefined();
		}
	});
});
