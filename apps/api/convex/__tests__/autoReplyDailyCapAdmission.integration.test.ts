/**
 * The legacy global daily cap (`agentConfig.maxDailyAutoReplies`) admits each
 * autonomous reply in the commit that approves it.
 *
 * The route step reads the count in an action, so two route steps can both
 * see the last free slot and both decide to auto-approve. Convex runs their
 * commits as if one after the other (the second conflicts on the usage row
 * and re-runs on the first one's count), so the tests replay that order:
 * both route steps decide first, then both commits land.
 */

import { convexTest } from 'convex-test';
import { getFunctionName } from 'convex/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { routeStep } from '../agent/steps/route';
import { routedOutcome } from '../agent/walkerTransition';
import { expectScheduledFailure } from './helpers/scheduledFailures';

beforeEach(() => {
	expectScheduledFailure('agent/walker:start');
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(MIDDAY);
});
afterEach(() => {
	vi.useRealTimers();
});

const MIDDAY = Date.UTC(2026, 10, 13, 12);
const MIDNIGHT = Date.UTC(2026, 10, 14);
const DAY = 24 * 60 * 60 * 1000;

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
			!path.endsWith('agent/walker.ts') &&
			!path.includes('agent/steps/index') &&
			!path.includes('agent/steps/shared') &&
			!path.includes('agent/steps/classify') &&
			!path.includes('agent/steps/draft') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('files/processing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

type T = ReturnType<typeof convexTest>;
type ExecuteCtx = Parameters<typeof routeStep.execute>[0];

async function seedCap(t: T, usage: { count: number; resetAt: number }) {
	await t.run(async (ctx) => {
		await ctx.db.insert('agentConfig', {
			isAutoReplyEnabled: true,
			confidenceThreshold: 0.8,
			maxDailyAutoReplies: 100,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		await ctx.db.insert('agentAutoReplyUsage', {
			dailyAutoReplyCount: usage.count,
			dailyAutoReplyResetAt: usage.resetAt,
			updatedAt: Date.now(),
		});
	});
}

async function seedDrafting(t: T, n: number): Promise<Id<'inboundMessages'>> {
	return await t.run((ctx) =>
		ctx.db.insert('inboundMessages', {
			messageId: `<cap-${n}@example.com>`,
			from: 'customer@example.com',
			to: 'support@owlat.app',
			subject: 'Order status',
			textBody: 'Where is my order?',
			processingStatus: 'drafting',
			receivedAt: Date.now(),
			draftResponse: 'Thanks for reaching out, your order ships tomorrow.',
		})
	);
}

/**
 * The route step's ctx with autonomy off (tier 3), every gate passing and
 * shadow mode off. The agent settings and the count come from the database.
 */
function routeCtx(t: T): ExecuteCtx {
	return {
		runQuery: async (ref: unknown) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.includes('getAgentConfig')) {
				return await t.query(internal.agent.agentPipeline.getAgentConfig, {});
			}
			if (name.includes('getCircuitBreakersInternal')) return [];
			if (name.includes('checkPermissionInternal')) return { mode: 'disabled', allowed: false };
			if (name.includes('getMessage')) {
				return {
					from: 'Customer <customer@example.com>',
					draftResponse: 'Thanks for reaching out, your order ships tomorrow.',
					securityFlags: { guardUnavailable: false },
				};
			}
			if (name.includes('getBudgetStatus')) return { autonomousAutoSendAllowed: true };
			if (name.includes('interpretationHold')) return { reason: null };
			if (name.includes('itemCoverageCheck'))
				return { objections: [], reason: null, isEnforced: false };
			if (name.includes('appliedVerdictInputs'))
				return { applied: [], isTruncated: false, isItemCoverageEnforced: false, current: null };
			if (name.includes('getShadowMode')) return { enabled: false };
			throw new Error(`unexpected runQuery: ${name}`);
		},
		runMutation: async (ref: unknown) => {
			throw new Error(`unexpected runMutation: ${getFunctionName(ref as never)}`);
		},
	} as unknown as ExecuteCtx;
}

type Decided = Awaited<ReturnType<typeof decide>>;

/** Open the route step and decide it, as the walker action does before its commit. */
async function decide(t: T, inboundMessageId: Id<'inboundMessages'>) {
	const begun = await t.mutation(internal.agent.walkerCommit.beginStep, {
		inboundMessageId,
		kind: 'route',
	});
	if (begun.kind !== 'begun') throw new Error('route step was held');
	const input = {
		inboundMessageId,
		confidence: 0.95,
		category: 'support',
		draftQuality: { score: 0.92, complete: true, grounded: true, flags: [] },
	};
	const result = await routeStep.execute(routeCtx(t), input);
	const route = routeStep.route(result.output, input, {} as never);
	return { inboundMessageId, begun, result, route };
}

async function commit(t: T, decided: Decided) {
	const { inboundMessageId, begun, result, route } = decided;
	return await t.mutation(internal.agent.walkerCommit.commitStep, {
		inboundMessageId,
		kind: 'route',
		actionId: begun.actionId,
		outcome: routedOutcome(route, result, begun.actionId, 0),
		writes: [...(result.writes ?? [])],
		...(begun.ranIn !== undefined ? { ranIn: begun.ranIn } : {}),
	});
}

async function message(t: T, id: Id<'inboundMessages'>) {
	return await t.run((ctx) => ctx.db.get(id));
}

async function usage(t: T) {
	const rows = await t.run((ctx) => ctx.db.query('agentAutoReplyUsage').collect());
	expect(rows).toHaveLength(1);
	return { count: rows[0]!.dailyAutoReplyCount, resetAt: rows[0]!.dailyAutoReplyResetAt };
}

describe('legacy global daily cap admission', () => {
	it('two approvals that both saw the last slot: one sends, the other goes to review', async () => {
		const t = convexTest(schema, modules);
		await seedCap(t, { count: 99, resetAt: MIDNIGHT });
		const first = await decide(t, await seedDrafting(t, 1));
		const second = await decide(t, await seedDrafting(t, 2));
		expect(first.result.output.decision).toBe('auto_approve');
		expect(second.result.output.decision).toBe('auto_approve');

		await commit(t, first);
		await commit(t, second);

		expect(await usage(t)).toEqual({ count: 100, resetAt: MIDNIGHT });
		expect((await message(t, first.inboundMessageId))?.processingStatus).toBe('approved');
		const held = await message(t, second.inboundMessageId);
		expect(held?.processingStatus).toBe('draft_ready');
		expect(held?.approvalSource).toBeUndefined();
		expect(held?.agentDecision).toMatchObject({
			decision: 'human_review',
			reason: 'Daily auto-reply limit reached (100/100). Routing to human review.',
		});
		const row = await t.run((ctx) => ctx.db.get(second.begun.actionId));
		expect(JSON.parse(row?.output ?? '{}')).toMatchObject({ decision: 'human_review' });
	});

	it('a commit after midnight admits the reply into the new day', async () => {
		const t = convexTest(schema, modules);
		await seedCap(t, { count: 99, resetAt: MIDNIGHT });
		const first = await decide(t, await seedDrafting(t, 1));
		const second = await decide(t, await seedDrafting(t, 2));

		await commit(t, first);
		expect(await usage(t)).toEqual({ count: 100, resetAt: MIDNIGHT });

		vi.setSystemTime(MIDNIGHT + 1);
		await commit(t, second);

		expect((await message(t, second.inboundMessageId))?.processingStatus).toBe('approved');
		expect(await usage(t)).toEqual({ count: 1, resetAt: MIDNIGHT + DAY });
	});
});
