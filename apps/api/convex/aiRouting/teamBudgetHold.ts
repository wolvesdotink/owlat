/**
 * D1 for the Team Inbox (ADR-0073, Phase 1b; #1333): at the spend ceiling,
 * a message is queued for a person instead of being drafted.
 *
 * The walker asks {@link holdIfOverBudget} before each step whose model call
 * is paid: context retrieval (interpretation and the query embedding),
 * classify (triage allowance), clarify and draft. The security scan is not
 * asked: its deterministic checks always run, and its model guard is admitted
 * at dispatch on the triage allowance; a refused guard leaves
 * `securityFlags.guardUnavailable`, which already blocks auto-send, and the
 * hold at the next step names it as a missing judgment.
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
import { BUDGET_HOLD_ERROR_MESSAGE, type MissingJudgment } from '@owlat/shared/aiRouting';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { internalMutation } from '../lib/writeFence';
import type { BudgetClass } from '../lib/validators/aiRouting';
import { budgetHeadroom } from './enforcedBudget';

/** The steps the walker asks about, and what each one's model call draws on. */
export const TEAM_PAID_STEPS = {
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
	return message.securityFlags?.guardUnavailable ? ['guard', ...missing] : missing;
}

const reasonValidator = v.union(
	v.literal('daily_ceiling'),
	v.literal('monthly_ceiling'),
	v.literal('spend_unverifiable')
);

const teamPaidStepValidator = v.union(
	v.literal('context_retrieval'),
	v.literal('classify'),
	v.literal('clarify'),
	v.literal('draft')
);

/**
 * Hold the message when the step has no headroom, or when its dispatch was
 * already refused (`refusedReason`, from the walker's catch). Returns whether
 * the walker must stop.
 */
export const holdIfOverBudget = internalMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		step: teamPaidStepValidator,
		refusedReason: v.optional(reasonValidator),
		/** The step row of the refused dispatch: closed as `abandoned`, so no cron retries it. */
		refusedActionId: v.optional(v.id('agentActions')),
	},
	returns: v.object({ isHeld: v.boolean() }),
	handler: async (ctx, args) => {
		const message = await ctx.db.get(args.inboundMessageId);
		if (!message) return { isHeld: false };
		let reason = args.refusedReason;
		if (reason === undefined) {
			const verdict = await budgetHeadroom(ctx, {
				priority: 'pipeline',
				budgetClass: TEAM_PAID_STEPS[args.step].budgetClass,
			});
			if (verdict.isAdmitted) {
				// A run with headroom clears the hold an earlier run left.
				if (message.budgetHold) await ctx.db.patch(message._id, { budgetHold: undefined });
				return { isHeld: false };
			}
			reason = verdict.reason;
		}
		const at = Date.now();
		if (args.refusedActionId) {
			const action = await ctx.db.get(args.refusedActionId);
			if (action && action.status !== 'abandoned') {
				await ctx.db.patch(action._id, {
					status: 'abandoned',
					errorMessage: BUDGET_HOLD_ERROR_MESSAGE,
					completedAt: at,
				});
			}
		}
		const outcome = await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: args.inboundMessageId,
			input: { to: 'failed', at, errorMessage: BUDGET_HOLD_ERROR_MESSAGE },
		});
		// A message the lifecycle would not fail (taken over, moved on) is not the
		// pipeline's any more; the walker stops either way.
		if (outcome.ok) {
			await ctx.db.patch(message._id, {
				budgetHold: { reason, missingJudgments: missingJudgmentsAt(args.step, message), at },
			});
		}
		return { isHeld: true };
	},
});
