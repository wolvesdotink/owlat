/**
 * The Team Inbox's budget hold (#1333): at the spend ceiling,
 * a message is queued for a person instead of being drafted.
 *
 * The walker asks {@link holdForBudget} before each step whose model call
 * is paid: context retrieval (interpretation and the query embedding),
 * classify (triage allowance), clarify and draft. The security scan is not
 * asked: its deterministic checks always run, and its model guard is admitted
 * at dispatch on the triage allowance. A refused guard stores the scan with
 * `securityFlags.guardNotRun { reason: 'budget_refused' }`, the
 * guard-skip marker, so auto-send is blocked and every later generative consumer
 * (interpretation, knowledge extraction, a briefing's history) runs the guard
 * first; the hold names it as a missing judgment.
 *
 * Without headroom (or with a spend state that cannot be verified) the
 * message gets `budgetHold { reason, missingJudgments, at }` and moves to
 * `failed` with {@link BUDGET_HOLD_ERROR_MESSAGE}, with no failed step row, so
 * the retry cron leaves it for a person. Auto-send is blocked by the hold
 * (`agent/steps/route/autoSendGates.ts`), the web shows the reason (U3), and a
 * person can reply by hand or press Retry. A run that finds headroom clears an
 * old hold.
 */

import { v } from 'convex/values';
import {
	BUDGET_HOLD_ERROR_MESSAGE,
	type BudgetHoldReason,
	type MissingJudgment,
} from '@owlat/shared/aiRouting';
import { internal } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { internalMutation } from '../lib/writeFence';
import type { BudgetClass } from '../lib/validators/aiRouting';
import { budgetHeadroom } from './enforcedBudget';

/** The steps the walker asks about, and what each one's model call draws on. */
export const TEAM_PAID_STEPS = {
	// Never asked before it runs (its deterministic checks always run); held
	// only when its model guard was refused at the dispatch.
	security_scan: {
		budgetClass: 'triage',
		missing: ['guard', 'interpret', 'classify', 'clarify', 'draft'],
	},
	context_retrieval: {
		budgetClass: 'standard',
		missing: ['interpret', 'classify', 'clarify', 'draft'],
	},
	classify: { budgetClass: 'triage', missing: ['classify', 'clarify', 'draft'] },
	clarify: { budgetClass: 'standard', missing: ['clarify', 'draft'] },
	draft: { budgetClass: 'standard', missing: ['draft'] },
} as const satisfies Record<
	string,
	{ budgetClass: BudgetClass; missing: readonly MissingJudgment[] }
>;

export type TeamPaidStep = keyof typeof TEAM_PAID_STEPS;

export function isTeamPaidStep(kind: string): kind is TeamPaidStep {
	return kind in TEAM_PAID_STEPS;
}

/** The judgments a hold at `step` leaves missing, the guard's included when it could not run. */
export function missingJudgmentsAt(
	step: TeamPaidStep,
	message: Pick<Doc<'inboundMessages'>, 'securityFlags'>
): MissingJudgment[] {
	const missing: MissingJudgment[] = [...TEAM_PAID_STEPS[step].missing];
	const flags = message.securityFlags;
	const isGuardMissing = flags?.guardUnavailable === true || flags?.guardNotRun !== undefined;
	return isGuardMissing && !missing.includes('guard') ? ['guard', ...missing] : missing;
}

const reasonValidator = v.union(
	v.literal('daily_ceiling'),
	v.literal('monthly_ceiling'),
	v.literal('spend_unverifiable')
);

const teamPaidStepValidator = v.union(
	v.literal('security_scan'),
	v.literal('context_retrieval'),
	v.literal('classify'),
	v.literal('clarify'),
	v.literal('draft')
);

export interface BudgetHoldRequest {
	readonly inboundMessageId: Id<'inboundMessages'>;
	readonly step: TeamPaidStep;
	/** The dispatch was already refused (from the walker's catch): hold without asking. */
	readonly refusedReason?: BudgetHoldReason;
	/** The step row of the refused dispatch: closed as `abandoned`, so no cron retries it. */
	readonly refusedActionId?: Id<'agentActions'>;
}

/**
 * Hold the message when the step has no headroom, or when its dispatch was
 * already refused. Returns whether the walker must stop.
 */
export async function holdForBudget(
	ctx: MutationCtx,
	request: BudgetHoldRequest
): Promise<{ isHeld: boolean }> {
	const message = await ctx.db.get(request.inboundMessageId);
	if (!message) return { isHeld: false };
	let reason = request.refusedReason;
	if (reason === undefined) {
		const verdict = await budgetHeadroom(ctx, {
			priority: 'pipeline',
			budgetClass: TEAM_PAID_STEPS[request.step].budgetClass,
		});
		if (verdict.isAdmitted) {
			// A run with headroom clears the hold an earlier run left.
			if (message.budgetHold) await ctx.db.patch(message._id, { budgetHold: undefined });
			return { isHeld: false };
		}
		reason = verdict.reason;
	}
	const at = Date.now();
	if (request.refusedActionId) {
		const action = await ctx.db.get(request.refusedActionId);
		if (action && action.status !== 'abandoned') {
			await ctx.db.patch(action._id, {
				status: 'abandoned',
				errorMessage: BUDGET_HOLD_ERROR_MESSAGE,
				completedAt: at,
			});
		}
	}
	const outcome = await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
		inboundMessageId: request.inboundMessageId,
		input: { to: 'failed', at, errorMessage: BUDGET_HOLD_ERROR_MESSAGE },
	});
	// A message the lifecycle would not fail (taken over, moved on) is not the
	// pipeline's any more; the walker stops either way.
	if (outcome.ok) {
		await ctx.db.patch(message._id, {
			budgetHold: { reason, missingJudgments: missingJudgmentsAt(request.step, message), at },
		});
	}
	return { isHeld: true };
}

/**
 * The previous release's walker asks this before a paid step and after a
 * refused one; the walker now holds inside its own step commits
 * (`agent/walkerCommit.ts`). Remove after release N+1.
 */
export const holdIfOverBudget = internalMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		step: teamPaidStepValidator,
		refusedReason: v.optional(reasonValidator),
		refusedActionId: v.optional(v.id('agentActions')),
	},
	returns: v.object({ isHeld: v.boolean() }),
	handler: (ctx, args) => holdForBudget(ctx, args),
});
