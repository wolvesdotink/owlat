/**
 * The routing policy panel's pure rules: the form a policy opens as, the
 * per-field problems (mirroring the server's `routingPolicyProblem`), the
 * shadow allowance preview, and the update arguments, which carry only what
 * changed so a save never rewrites a value the admin did not touch.
 */
import { describe, expect, it } from 'vitest';
import {
	ROUTING_SWITCH_KEYS,
	resolveRoutingPolicy,
	routingPolicyProblem,
	type ResolvedRoutingPolicy,
} from '@owlat/shared/aiRouting';
import {
	PROMPT_CACHE_TASK,
	ROUTING_POLICY_GROUPS,
	draftShadowAllowanceUsd,
	routingPolicyFormOf,
	routingPolicyFormProblems,
	routingPolicyUpdateArgs,
	routingSwitchOptions,
} from '../aiRoutingPolicy';

const defaults = resolveRoutingPolicy(null);

function stored(row: Parameters<typeof resolveRoutingPolicy>[0] = {}): ResolvedRoutingPolicy {
	return resolveRoutingPolicy({ policyVersion: 3, updatedAt: 1_700_000_000_000, ...row });
}

describe('routingPolicyFormOf', () => {
	it('opens the defaults as off switches, empty caps and percentages', () => {
		const form = routingPolicyFormOf(defaults);
		for (const key of ROUTING_SWITCH_KEYS) expect(form.switches[key]).toBe('off');
		expect(form).toMatchObject({
			knowledgeEntryCap: '',
			verifyClaimCap: '',
			isInterpretationCached: false,
			triagePercent: '10',
			shadowMessagePercent: '10',
			shadowCeilingPercent: '5',
			shadowCapUsd: '',
		});
	});

	it('opens a stored policy as it is stored', () => {
		const form = routingPolicyFormOf(
			stored({
				triageBundle: 'shadow',
				knowledgeEntryCapPerMessage: 12,
				promptCacheTasks: [PROMPT_CACHE_TASK],
				triageAllowanceFraction: 0.25,
				shadowMaxCeilingFraction: 0.025,
				shadowCapUsd: 1.5,
			})
		);
		expect(form.switches.triageBundle).toBe('shadow');
		expect(form).toMatchObject({
			knowledgeEntryCap: '12',
			isInterpretationCached: true,
			triagePercent: '25',
			shadowCeilingPercent: '2.5',
			shadowCapUsd: '1.5',
		});
	});
});

describe('routingSwitchOptions', () => {
	it('names the default value as the default, and offers every value', () => {
		expect(routingSwitchOptions('triageBundle').map((o) => o.value)).toEqual(['off', 'shadow']);
		expect(routingSwitchOptions('claimVerification').map((o) => o.label)).toEqual([
			'dashboard.admin.instance.aiProvider.routing.values.offDefault',
			'dashboard.admin.instance.aiProvider.routing.values.shadow',
			'dashboard.admin.instance.aiProvider.routing.values.enforce',
		]);
	});

	it('every switch sits in exactly one group', () => {
		const grouped = ROUTING_POLICY_GROUPS.flatMap((group) => group.switches);
		expect([...grouped].sort()).toEqual([...ROUTING_SWITCH_KEYS].sort());
	});
});

describe('routingPolicyFormProblems', () => {
	const ceiling = { dailyCeilingUsd: 25 };

	it('has none for the defaults', () => {
		expect(routingPolicyFormProblems(routingPolicyFormOf(defaults), ceiling)).toEqual({});
	});

	it('bounds the caps and the three shares', () => {
		const form = {
			...routingPolicyFormOf(defaults),
			knowledgeEntryCap: '1001',
			verifyClaimCap: '2.5',
			triagePercent: '100',
			shadowMessagePercent: '11',
			shadowCeilingPercent: '0',
			shadowCapUsd: '-3',
		};
		const problems = routingPolicyFormProblems(form, ceiling);
		expect(Object.keys(problems).sort()).toEqual([
			'knowledgeEntryCap',
			'shadowCapUsd',
			'shadowCeilingPercent',
			'shadowMessagePercent',
			'triagePercent',
			'verifyClaimCap',
		]);
		expect(problems.shadowMessagePercent).toEqual({
			key: 'dashboard.admin.instance.aiProvider.routing.problems.percentUpTo',
			params: { max: 10 },
		});
		expect(problems.triagePercent?.key).toMatch(/percentBelow$/);
	});

	it('accepts the D4 maxima themselves and a comma decimal', () => {
		const form = {
			...routingPolicyFormOf(defaults),
			shadowMessagePercent: '10',
			shadowCeilingPercent: '2,5',
			triagePercent: '99.5',
		};
		expect(routingPolicyFormProblems(form, ceiling)).toEqual({});
	});

	it('needs a shadow cap only while a switch is in shadow and no daily ceiling is set (D4)', () => {
		const form = routingPolicyFormOf(defaults);
		form.switches.triageBundle = 'shadow';
		expect(routingPolicyFormProblems(form, { dailyCeilingUsd: 0 }).shadowCapUsd?.key).toMatch(
			/shadowCapRequired$/
		);
		expect(routingPolicyFormProblems(form, ceiling)).toEqual({});
		form.shadowCapUsd = '2';
		expect(routingPolicyFormProblems(form, { dailyCeilingUsd: 0 })).toEqual({});
	});

	describe('stored values at the boundaries (Sol r2 F1)', () => {
		const boundaries = [
			{ triageAllowanceFraction: 0.9999999 },
			{ triageAllowanceFraction: 0.0000001 },
			{ shadowMaxMessageFraction: 0.0000001 },
			{ shadowMaxCeilingFraction: 0.0000001 },
			{ shadowMaxMessageFraction: 0.1, shadowMaxCeilingFraction: 0.05 },
			{ shadowMaxMessageFraction: 0.0999999, shadowMaxCeilingFraction: 0.0499999 },
		];

		it.each(boundaries)('an untouched stored %o blocks nothing', (row) => {
			const policy = stored(row);
			// The server accepted it, and the shared resolver keeps it.
			for (const [key, value] of Object.entries(row)) {
				expect(policy[key as keyof typeof row]).toBe(value);
			}
			const opened = routingPolicyFormOf(policy);
			expect(routingPolicyFormProblems(opened, { ...ceiling, opened })).toEqual({});
			// Saving another field carries that field only, the stored value untouched.
			const form = { ...opened, switches: { ...opened.switches, batchApi: 'enforce' } };
			expect(routingPolicyFormProblems(form, { ...ceiling, opened })).toEqual({});
			expect(routingPolicyUpdateArgs(form, policy)).toEqual({
				expectedPolicyVersion: 3,
				batchApi: 'enforce',
			});
		});

		it('still checks a boundary value once it is edited', () => {
			const opened = routingPolicyFormOf(stored({ triageAllowanceFraction: 0.9999999 }));
			expect(opened.triagePercent).toBe('100');
			const edited = { ...opened, triagePercent: '100.0' };
			expect(routingPolicyFormProblems(edited, { ...ceiling, opened }).triagePercent?.key).toMatch(
				/percentBelow$/
			);
			const message = { ...opened, shadowMessagePercent: '10.5' };
			expect(
				routingPolicyFormProblems(message, { ...ceiling, opened }).shadowMessagePercent
			).toBeDefined();
			const exact = { ...opened, shadowMessagePercent: '10', shadowCeilingPercent: '5' };
			expect(routingPolicyFormProblems(exact, { ...ceiling, opened })).toEqual({});
		});

		it('keeps the D4 cap rule for an untouched empty cap', () => {
			const opened = routingPolicyFormOf(stored());
			const form = { ...opened, switches: { ...opened.switches, triageBundle: 'shadow' } };
			expect(
				routingPolicyFormProblems(form, { dailyCeilingUsd: 0, opened }).shadowCapUsd?.key
			).toMatch(/shadowCapRequired$/);
		});
	});

	it('agrees with the server on what it refuses', () => {
		const form = routingPolicyFormOf(defaults);
		form.switches.clarifyNecessity = 'shadow';
		const server = routingPolicyProblem({ clarifyNecessity: 'shadow' }, { dailyCeilingUsd: 0 });
		expect(server).not.toBeNull();
		expect(routingPolicyFormProblems(form, { dailyCeilingUsd: 0 }).shadowCapUsd).toBeDefined();
	});
});

describe('draftShadowAllowanceUsd', () => {
	it('is zero while nothing is shadowed', () => {
		expect(draftShadowAllowanceUsd(routingPolicyFormOf(defaults), defaults, 25)).toBe(0);
	});

	it('is the smaller of the ceiling share and the cap, as the form stands', () => {
		const form = routingPolicyFormOf(defaults);
		form.switches.triageBundle = 'shadow';
		expect(draftShadowAllowanceUsd(form, defaults, 100)).toBeCloseTo(5);
		form.shadowCapUsd = '2';
		expect(draftShadowAllowanceUsd(form, defaults, 100)).toBe(2);
		form.shadowCeilingPercent = '1';
		expect(draftShadowAllowanceUsd(form, defaults, 100)).toBeCloseTo(1);
	});
});

describe('routingPolicyUpdateArgs', () => {
	it('is null when nothing changed, the stored defaults included', () => {
		expect(routingPolicyUpdateArgs(routingPolicyFormOf(defaults), defaults)).toBeNull();
		const policy = stored({ triageAllowanceFraction: 0.07, shadowCapUsd: 3 });
		expect(routingPolicyUpdateArgs(routingPolicyFormOf(policy), policy)).toBeNull();
	});

	it('sends only the changed fields, against the loaded version', () => {
		const policy = stored();
		const form = routingPolicyFormOf(policy);
		form.switches.attachmentGates = 'enforce';
		form.triagePercent = '20';
		form.knowledgeEntryCap = '8';
		expect(routingPolicyUpdateArgs(form, policy)).toEqual({
			expectedPolicyVersion: 3,
			attachmentGates: 'enforce',
			knowledgeEntryCapPerMessage: 8,
			triageAllowanceFraction: 0.2,
		});
	});

	it('clears a cap with null and toggles only the offered cache task', () => {
		const policy = stored({
			verifyClaimCapPerMessage: 5,
			shadowCapUsd: 4,
			promptCacheTasks: ['mail.classify', PROMPT_CACHE_TASK],
		});
		const form = routingPolicyFormOf(policy);
		form.verifyClaimCap = ' ';
		form.shadowCapUsd = '';
		form.isInterpretationCached = false;
		expect(routingPolicyUpdateArgs(form, policy)).toEqual({
			expectedPolicyVersion: 3,
			verifyClaimCapPerMessage: null,
			shadowCapUsd: null,
			promptCacheTasks: ['mail.classify'],
		});
	});

	it('leaves untouched fields exactly as stored: no rounded percentage, no reordered list', () => {
		const policy = stored({
			triageAllowanceFraction: 0.123456789,
			shadowMaxCeilingFraction: 0.0333333333,
			promptCacheTasks: [PROMPT_CACHE_TASK, 'mail.classify'],
		});
		const form = routingPolicyFormOf(policy);
		expect(form.triagePercent).toBe('12.3457');
		expect(routingPolicyUpdateArgs(form, policy)).toBeNull();
		// Another field's edit carries only that field.
		form.switches.batchApi = 'enforce';
		expect(routingPolicyUpdateArgs(form, policy)).toEqual({
			expectedPolicyVersion: 3,
			batchApi: 'enforce',
		});
		// The draft keeps the stored precision too.
		expect(draftShadowAllowanceUsd(form, policy, 100)).toBe(0);
		form.switches.triageBundle = 'shadow';
		expect(draftShadowAllowanceUsd(form, policy, 300)).toBeCloseTo(9.99999999, 8);
	});

	it('toggles the offered cache task without reordering the others', () => {
		const policy = stored({ promptCacheTasks: ['mail.classify', PROMPT_CACHE_TASK, 'mail.draft'] });
		const form = routingPolicyFormOf(policy);
		form.isInterpretationCached = false;
		expect(routingPolicyUpdateArgs(form, policy)?.promptCacheTasks).toEqual([
			'mail.classify',
			'mail.draft',
		]);
	});

	it('takes an edited percentage at full precision, and an edit back as no change', () => {
		const policy = stored({ triageAllowanceFraction: 0.123456789 });
		const form = routingPolicyFormOf(policy);
		form.triagePercent = '12.5';
		expect(routingPolicyUpdateArgs(form, policy)).toEqual({
			expectedPolicyVersion: 3,
			triageAllowanceFraction: 0.125,
		});
		form.triagePercent = '12.3456789';
		expect(routingPolicyUpdateArgs(form, policy)).toBeNull();
	});

	it('starts from version 0 before the first save', () => {
		const form = routingPolicyFormOf(defaults);
		form.isInterpretationCached = true;
		expect(routingPolicyUpdateArgs(form, defaults)).toEqual({
			expectedPolicyVersion: 0,
			promptCacheTasks: [PROMPT_CACHE_TASK],
		});
	});
});
