/**
 * The spend ceiling as the gates enforce it.
 *
 * Enforcement reads the complete period totals and outstanding holds
 * (`./admissionState.ts`), never the newest-12,000-row scan the dashboard
 * still shows (`analytics/spendBudget.ts` `getBudgetStatusAdmin`), and it
 * fails closed: with a ceiling configured, a spend state that cannot be
 * verified refuses, where the old gates allowed the call.
 *
 * - {@link getBudgetStatus}: the autonomous auto-send gate's read (same shape
 *   as before). Throws when the state is unverifiable; the gate holds the send.
 * - {@link budgetHeadroom}: the verdict for a call of a priority, for the gates
 *   that refuse before any work starts (`mail/ai/gate.ts`, `mail/interpret/gate.ts`).
 * - {@link throwBudgetRefused}: the user-facing refusal, with the stable code
 *   the web reads (U5).
 */

import { internalQuery, type QueryCtx } from '../_generated/server';
import { evaluateBudget, type BudgetStatus } from '../analytics/spendBudget';
import { throwForbidden } from '../_utils/errors';
import { AI_BUDGET_ERROR_CODE } from '@owlat/shared/aiRouting';
import type { AdmissionVerdict } from '../lib/aiRouting/admissionRules';
import type { AdmissionPriority, BudgetClass } from '../lib/validators/aiRouting';
import type { LlmUsagePlane } from '../lib/llmUsageTags';
import { AdmissionRefusedError } from '../lib/llm/admissionPort';
import { admissionVerdict, loadAdmissionContext, readSpendSnapshot } from './admissionState';

type DbCtx = { db: QueryCtx['db'] };

function sum(totals: Record<string, Record<string, number>>): number {
	let total = 0;
	for (const plane of Object.values(totals))
		for (const value of Object.values(plane)) total += value;
	return total;
}

/**
 * The budget picture from the aggregate: settled spend of the current day and
 * month against the ceilings. Throws when a ceiling is set and the totals
 * cannot be verified.
 */
export async function enforcedBudgetStatus(ctx: DbCtx): Promise<BudgetStatus> {
	const context = await loadAdmissionContext(ctx);
	const { config } = context;
	if (config.dailyUsd <= 0 && config.monthlyUsd <= 0) return evaluateBudget(config, 0, 0);
	const snapshot = await readSpendSnapshot(ctx, Date.now());
	if (!snapshot.isVerifiable) {
		throw new Error(`AI spend cannot be verified (${snapshot.why}).`);
	}
	return evaluateBudget(
		config,
		sum(snapshot.day.settled) / 1_000_000,
		sum(snapshot.month.settled) / 1_000_000
	);
}

/** The autonomous route step's gate (`agent/steps/route/autoSendGates.ts`). */
export const getBudgetStatus = internalQuery({
	args: {},
	handler: (ctx): Promise<BudgetStatus> => enforcedBudgetStatus(ctx),
});

/** The verdict a smallest call of this shape would get now; nothing is held. */
export async function budgetHeadroom(
	ctx: DbCtx,
	shape: {
		readonly priority: AdmissionPriority;
		readonly budgetClass?: BudgetClass;
		readonly plane?: LlmUsagePlane;
	}
): Promise<AdmissionVerdict> {
	const context = await loadAdmissionContext(ctx);
	return admissionVerdict(
		ctx,
		context,
		{
			plane: shape.plane ?? 'language',
			budgetClass: shape.budgetClass ?? 'standard',
			priority: shape.priority,
			microusd: 1,
		},
		Date.now()
	);
}

/**
 * Refuse a user's AI action over the budget, in the Operation error shape:
 * `forbidden`, with `data.code` = `AI_BUDGET_EXHAUSTED` and the hold reason.
 */
export function throwBudgetRefused(
	verdict: Extract<AdmissionVerdict, { isAdmitted: false }>
): never {
	const refusal = new AdmissionRefusedError(verdict.reason, verdict.limit);
	throwForbidden(refusal.data.message, {
		code: AI_BUDGET_ERROR_CODE,
		reason: verdict.reason,
		limit: verdict.limit,
	});
}
