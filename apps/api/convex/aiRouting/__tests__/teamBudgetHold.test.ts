/**
 * The Team Inbox's budget hold (#1333): at the ceiling a message is queued
 * for a person with a visible reason and its missing judgments, auto-send is
 * blocked, and a re-run with headroom clears the hold.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUDGET_HOLD_ERROR_MESSAGE } from '@owlat/shared/aiRouting';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { newHarness } from '../../__tests__/testModules';
import { insertLlmUsage } from '../../analytics/ledgerInsert';
import { missingJudgmentsAt } from '../teamBudgetHold';
import { reconcileSpend } from './spend.testlib';

afterEach(() => {
	vi.unstubAllEnvs();
});

type T = ReturnType<typeof newHarness>;

async function message(t: T, over: Record<string, unknown> = {}): Promise<Id<'inboundMessages'>> {
	return t.run((ctx) =>
		ctx.db.insert('inboundMessages', {
			messageId: 'msg-d1',
			from: 'ana@example.com',
			to: 'support@owlat.app',
			subject: 'Hi',
			textBody: 'Question',
			processingStatus: 'classifying',
			receivedAt: Date.now(),
			...over,
		} as never)
	);
}

/** Spend `usd` of standard language spend through the ledger's own insert. */
async function spend(t: T, usd: number, feature = 'agent_draft') {
	await t.run(async (ctx) => {
		// gpt-4o input: $2.50 per million tokens.
		const promptTokens = Math.round((usd / 2.5) * 1_000_000);
		await insertLlmUsage(
			ctx,
			feature,
			{ promptTokens, completionTokens: 0, totalTokens: promptTokens },
			'gpt-4o'
		);
	});
}

describe('aiRouting.teamBudgetHold.holdIfOverBudget', () => {
	it('lets the step run with headroom, and holds nothing with no ceiling (today)', async () => {
		const t = newHarness();
		const id = await message(t);
		await spend(t, 1_000);
		expect(
			await t.mutation(internal.aiRouting.teamBudgetHold.holdIfOverBudget, {
				inboundMessageId: id,
				step: 'draft',
			})
		).toEqual({ isHeld: false });
	});

	it('queues the message for a person at the ceiling, with the reason and missing judgments', async () => {
		vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', '1');
		const t = newHarness();
		await reconcileSpend(t);
		const id = await message(t, {
			securityFlags: {
				injectionDetected: false,
				confidence: 0,
				guardUnavailable: true,
				scanTimestamp: Date.now(),
			},
		});
		await spend(t, 1);

		const result = await t.mutation(internal.aiRouting.teamBudgetHold.holdIfOverBudget, {
			inboundMessageId: id,
			step: 'context_retrieval',
		});

		expect(result).toEqual({ isHeld: true });
		const held = await t.run((ctx) => ctx.db.get(id));
		expect(held).toMatchObject({
			processingStatus: 'failed',
			errorMessage: BUDGET_HOLD_ERROR_MESSAGE,
			budgetHold: {
				reason: 'daily_ceiling',
				missingJudgments: ['guard', 'interpret', 'classify', 'clarify', 'draft'],
			},
		});
		// No failed step row: the retry cron does not churn on it.
		const actions = await t.run((ctx) => ctx.db.query('agentActions').collect());
		expect(actions).toHaveLength(0);
	});

	it('holds while the spend state cannot be verified', async () => {
		vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', '100');
		const t = newHarness();
		const id = await message(t);
		await t.mutation(internal.aiRouting.teamBudgetHold.holdIfOverBudget, {
			inboundMessageId: id,
			step: 'classify',
		});
		const held = await t.run((ctx) => ctx.db.get(id));
		expect(held?.budgetHold).toMatchObject({
			reason: 'spend_unverifiable',
			missingJudgments: ['classify', 'clarify', 'draft'],
		});
	});

	it('lets paid classification use the triage allowance after standard work has stopped', async () => {
		vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', '10');
		const t = newHarness();
		await reconcileSpend(t);
		// $9.50 of standard spend: standard work is past $9 (10 less the unused $1).
		await spend(t, 9.5);
		const classifying = await message(t);
		const drafting = await message(t, { processingStatus: 'drafting' });

		expect(
			await t.mutation(internal.aiRouting.teamBudgetHold.holdIfOverBudget, {
				inboundMessageId: classifying,
				step: 'classify',
			})
		).toEqual({ isHeld: false });
		expect(
			await t.mutation(internal.aiRouting.teamBudgetHold.holdIfOverBudget, {
				inboundMessageId: drafting,
				step: 'draft',
			})
		).toEqual({ isHeld: true });
	});

	it('records a refusal the dispatch raised mid-step, and closes its step row for good', async () => {
		vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', '100');
		const t = newHarness();
		await reconcileSpend(t);
		const id = await message(t, { processingStatus: 'drafting' });
		const actionId = await t.run((ctx) =>
			ctx.db.insert('agentActions', {
				inboundMessageId: id,
				actionType: 'draft',
				status: 'running',
				retryCount: 0,
				startedAt: Date.now(),
				createdAt: Date.now(),
			} as never)
		);

		await t.mutation(internal.aiRouting.teamBudgetHold.holdIfOverBudget, {
			inboundMessageId: id,
			step: 'draft',
			refusedReason: 'monthly_ceiling',
			refusedActionId: actionId,
		});

		const held = await t.run((ctx) => ctx.db.get(id));
		expect(held?.budgetHold).toMatchObject({
			reason: 'monthly_ceiling',
			missingJudgments: ['draft'],
		});
		const action = await t.run((ctx) => ctx.db.get(actionId));
		expect(action?.status).toBe('abandoned');
	});

	it('clears the hold when the message leaves `failed` for a re-run', async () => {
		vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', '1');
		const t = newHarness();
		await reconcileSpend(t);
		const id = await message(t);
		await spend(t, 1);
		await t.mutation(internal.aiRouting.teamBudgetHold.holdIfOverBudget, {
			inboundMessageId: id,
			step: 'classify',
		});
		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: id,
			input: { to: 'received', at: Date.now(), source: 'cron_retry' },
		});
		const rerun = await t.run((ctx) => ctx.db.get(id));
		expect(rerun?.processingStatus).toBe('received');
		expect(rerun?.budgetHold).toBeUndefined();
	});
});

describe('missingJudgmentsAt', () => {
	it('names the step and everything after it, the guard too when it could not run', () => {
		expect(missingJudgmentsAt('clarify', {})).toEqual(['clarify', 'draft']);
		expect(
			missingJudgmentsAt('draft', { securityFlags: { guardUnavailable: true } } as never)
		).toEqual(['guard', 'draft']);
	});
});
