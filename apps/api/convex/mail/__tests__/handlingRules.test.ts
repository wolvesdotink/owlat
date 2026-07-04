/**
 * Natural-language handling rules.
 *
 * Two layers under test:
 *   1. The PURE deterministic evaluator (`evaluateHandlingRules`) — matching,
 *      action application, and the "can only RESTRICT auto-send" invariant.
 *   2. The rule lifecycle via convex-test — compile write-back, the inert-until-
 *      active guarantee, and revocation.
 *
 * The compile step (an LLM call) is never exercised here; `applyCompilation`
 * stands in for its output (the spec's "mock the compile call").
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import {
	evaluateHandlingRules,
	toHandlingEvalMessage,
	type HandlingEvalMessage,
} from '../handlingRules';

// Owner/admin gate is orthogonal to what these tests assert — resolve it.
vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgPermission: vi.fn(async () => undefined),
		requireOrgMember: vi.fn(async () => ({ userId: 'user-A', role: 'owner' })),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => ({ userId: 'user-A', role: 'owner' })),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: 'user-A',
			role: 'owner',
			activeOrganizationId: 'org-1',
		})),
	};
});

// Exclude the 'use node' modules that break under convex-test's runtime (LLM
// provider + agent node steps + our own compile action). The compile action is
// only ever scheduled here, never run.
const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules)
		.filter(
			([path]) =>
				!path.includes('handlingRulesCompile') &&
				!path.includes('sesActions') &&
				!path.includes('agentSecurity') &&
				!path.includes('agentContext') &&
				!path.includes('agentClassifier') &&
				!path.includes('agentDrafter') &&
				!path.includes('agentRouter') &&
				!path.includes('agent/walker') &&
				!path.includes('agent/steps/index') &&
				!path.includes('agent/steps/shared') &&
				!path.includes('agent/steps/classify') &&
				!path.includes('agent/steps/draft') &&
				!path.includes('knowledgeExtraction') &&
				!path.includes('semanticFileProcessing') &&
				!path.includes('visualizationAgent') &&
				!path.includes('llmProvider')
		)
		.map(([key, val]) =>
			key.startsWith('../') && !key.startsWith('../../')
				? (['../../mail/' + key.slice(3), val] as const)
				: ([key, val] as const)
		)
);

// ── Test fixtures for the pure evaluator ──────────────────────────

const BASE = {
	naturalLanguage: 'test rule',
	status: 'active' as const,
	isEnabled: true,
	createdAt: 0,
	updatedAt: 0,
};

/** Build a rule doc for the pure evaluator (no persistence). */
function rule(overrides: Partial<Doc<'handlingRules'>>): Doc<'handlingRules'> {
	return {
		_id: 'rule_x' as Id<'handlingRules'>,
		_creationTime: 0,
		...BASE,
		...overrides,
	} as Doc<'handlingRules'>;
}

function fromRule(
	action: Doc<'handlingRules'>['action'],
	senderNeedle: string,
	extra: Partial<Doc<'handlingRules'>> = {}
): Doc<'handlingRules'> {
	return rule({
		action,
		matcher: { conditions: [{ field: 'from', op: 'contains', value: senderNeedle }] },
		...extra,
	});
}

const msgFrom = (from: string): HandlingEvalMessage =>
	toHandlingEvalMessage({ from, subject: '', textBody: '', htmlBody: '' });

describe('evaluateHandlingRules — matching + actions', () => {
	it('matches its sender and reports the matched rule', () => {
		const r = fromRule('never_auto_send', 'legal@acme.com');
		const hit = evaluateHandlingRules([r], msgFrom('Jane <legal@acme.com>'));
		expect(hit.matchedRuleIds).toEqual([r._id]);

		const miss = evaluateHandlingRules([r], msgFrom('Bob <sales@other.com>'));
		expect(miss.matchedRuleIds).toEqual([]);
	});

	it('applies categorize by forcing the category', () => {
		const r = fromRule('categorize', 'billing@', { category: 'billing' });
		const out = evaluateHandlingRules([r], msgFrom('billing@vendor.com'));
		expect(out.forcedCategory).toBe('billing');
		expect(out.restrictAutoSend).toBe(false); // categorize never restricts
	});

	it('applies auto_archive', () => {
		const r = fromRule('auto_archive', 'newsletter@');
		const out = evaluateHandlingRules([r], msgFrom('newsletter@list.com'));
		expect(out.autoArchive).toBe(true);
	});

	it('applies draft_with_stance by surfacing the stance', () => {
		const r = fromRule('draft_with_stance', 'recruiter@', { stance: 'a polite decline' });
		const out = evaluateHandlingRules([r], msgFrom('recruiter@hire.io'));
		expect(out.stances).toEqual(['a polite decline']);
	});

	it('AND-s multiple conditions', () => {
		const r = rule({
			action: 'never_auto_send',
			matcher: {
				conditions: [
					{ field: 'from', op: 'contains', value: 'acme.com' },
					{ field: 'subject', op: 'contains', value: 'invoice' },
				],
			},
		});
		const both = evaluateHandlingRules(
			[r],
			toHandlingEvalMessage({ from: 'ap@acme.com', subject: 'Overdue invoice', textBody: '' })
		);
		expect(both.matchedRuleIds).toEqual([r._id]);
		const onlyOne = evaluateHandlingRules(
			[r],
			toHandlingEvalMessage({ from: 'ap@acme.com', subject: 'hello', textBody: '' })
		);
		expect(onlyOne.matchedRuleIds).toEqual([]);
	});
});

describe('evaluateHandlingRules — never-auto-send / restrict-only invariant', () => {
	it('a never_auto_send rule flags the message for human review', () => {
		const r = fromRule('never_auto_send', 'legal@');
		const out = evaluateHandlingRules([r], msgFrom('legal@corp.com'));
		expect(out.restrictAutoSend).toBe(true);
		expect(out.restrictReason).toBeTruthy();
	});

	it('always_ask and draft_with_stance also restrict auto-send', () => {
		for (const action of ['always_ask', 'draft_with_stance'] as const) {
			const out = evaluateHandlingRules([fromRule(action, 'x@')], msgFrom('x@y.com'));
			expect(out.restrictAutoSend).toBe(true);
		}
	});

	it('a rule can NEVER widen auto-send — no matched action grants a send', () => {
		// Whatever the action, the outcome exposes only restrict/archive/category
		// signals; there is no field that could turn human-review into a send.
		for (const action of [
			'draft_with_stance',
			'categorize',
			'auto_archive',
			'always_ask',
			'never_auto_send',
		] as const) {
			const out = evaluateHandlingRules([fromRule(action, 'a@')], msgFrom('a@b.com'));
			// The only send-affecting field only ever tightens.
			expect(Object.keys(out)).not.toContain('allowAutoSend');
			expect(out.restrictAutoSend).toBe(action !== 'categorize' && action !== 'auto_archive');
		}
	});

	it('non-restricting rules leave auto-send untouched (restrictAutoSend=false)', () => {
		const out = evaluateHandlingRules(
			[fromRule('categorize', 'a@', { category: 'support' })],
			msgFrom('a@b.com')
		);
		expect(out.restrictAutoSend).toBe(false);
	});
});

describe('evaluateHandlingRules — inert rules are ignored', () => {
	it('ignores disabled, non-active, and matcher-less rules', () => {
		const m = msgFrom('legal@corp.com');
		expect(
			evaluateHandlingRules([fromRule('never_auto_send', 'legal@', { isEnabled: false })], m)
				.restrictAutoSend
		).toBe(false);
		expect(
			evaluateHandlingRules([fromRule('never_auto_send', 'legal@', { status: 'compiling' })], m)
				.restrictAutoSend
		).toBe(false);
		expect(
			evaluateHandlingRules([rule({ action: 'never_auto_send', matcher: undefined })], m)
				.restrictAutoSend
		).toBe(false);
	});
});

// ── Lifecycle via convex-test ─────────────────────────────────────

async function insertCompiling(t: ReturnType<typeof convexTest>, text: string) {
	return t.run(async (ctx) => {
		const now = Date.now();
		return ctx.db.insert('handlingRules', {
			naturalLanguage: text,
			status: 'compiling',
			isEnabled: true,
			createdAt: now,
			updatedAt: now,
		});
	});
}

describe('handling rule lifecycle', () => {
	it('a still-compiling rule is inert (listActiveInternal excludes it)', async () => {
		const t = convexTest(schema, modules);
		await insertCompiling(t, 'decline recruiters');
		const active = await t.query(internal.mail.handlingRules.listActiveInternal, {});
		expect(active).toEqual([]);
	});

	it('applyCompilation activates the rule; it then matches its sender', async () => {
		const t = convexTest(schema, modules);
		const ruleId = await insertCompiling(t, 'never auto-send legal');
		await t.mutation(internal.mail.handlingRules.applyCompilation, {
			ruleId,
			result: {
				matcher: { conditions: [{ field: 'from', op: 'contains', value: 'legal@' }] },
				action: 'never_auto_send',
			},
		});
		const active = await t.query(internal.mail.handlingRules.listActiveInternal, {});
		expect(active).toHaveLength(1);
		expect(active[0]?.status).toBe('active');

		const out = evaluateHandlingRules(
			active as Doc<'handlingRules'>[],
			msgFrom('counsel legal@corp.com')
		);
		expect(out.restrictAutoSend).toBe(true);
	});

	it('applyCompilation with an error marks the rule failed + inert', async () => {
		const t = convexTest(schema, modules);
		const ruleId = await insertCompiling(t, 'gibberish');
		await t.mutation(internal.mail.handlingRules.applyCompilation, {
			ruleId,
			error: 'Could not compile this rule.',
		});
		const doc = await t.run((ctx) => ctx.db.get(ruleId));
		expect(doc?.status).toBe('failed');
		expect(doc?.compileError).toBeTruthy();
		expect(await t.query(internal.mail.handlingRules.listActiveInternal, {})).toEqual([]);
	});

	it('rules are revocable: remove deletes the rule so it no longer matches', async () => {
		const t = convexTest(schema, modules);
		const ruleId = await insertCompiling(t, 'never auto-send legal');
		await t.mutation(internal.mail.handlingRules.applyCompilation, {
			ruleId,
			result: {
				matcher: { conditions: [{ field: 'from', op: 'contains', value: 'legal@' }] },
				action: 'never_auto_send',
			},
		});
		expect(await t.query(internal.mail.handlingRules.listActiveInternal, {})).toHaveLength(1);

		await t.mutation(api.mail.handlingRules.remove, { ruleId });

		expect(await t.query(internal.mail.handlingRules.listActiveInternal, {})).toEqual([]);
		expect(await t.run((ctx) => ctx.db.get(ruleId))).toBeNull();
	});
});
