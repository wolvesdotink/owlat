/**
 * The walker's commits (`./walker.ts`). A step makes two writes around its
 * model calls, and only two:
 *
 *   - {@link beginStep}, before the calls: the budget hold for a paid step,
 *     or the step's `running` row the rest of the step is recorded against;
 *   - {@link commitStep}, after them: the step's result (its row, the
 *     lifecycle transition it routed to, or the failure or hold it ran into)
 *     together with the next `runStep`, so the next hop exists exactly when
 *     the step's result does.

 */

import { v, type Infer } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { internalMutation } from '../lib/writeFence';
import { tokenUsageValidator } from '../lib/convexValidators';
import { budgetHoldValidator } from '../lib/validators/aiRouting';
import { holdForBudget, isTeamPaidStep } from '../aiRouting/teamBudgetHold';
import { transitionInputValidator } from '../inbox/processingLifecycle/types';
import {
	applyTransition,
	beginStepAction,
	endStepAction,
	failStepAction,
} from '../inbox/processingLifecycle/stepActions';
import { agentStepKindValidator } from './steps/catalog';
import { nextStepValidator, scheduleAfterCoreStep } from './walkerSchedule';

const stepEndFields = {
	output: v.optional(v.string()),
	durationMs: v.number(),
	modelUsed: v.optional(v.string()),
	tokenUsage: v.optional(tokenUsageValidator),
};

/** What a step came to, as the walker action decided it after the model calls. */
export const stepOutcomeValidator = v.union(
	v.object({ kind: v.literal('in_state'), ...stepEndFields, nextStep: nextStepValidator }),
	v.object({
		kind: v.literal('transition'),
		input: transitionInputValidator,
		nextStep: v.optional(nextStepValidator),
	}),
	v.object({ kind: v.literal('done'), ...stepEndFields }),
	v.object({ kind: v.literal('failed'), errorMessage: v.string() }),
	v.object({ kind: v.literal('refused'), reason: budgetHoldValidator.fields.reason })
);

export type StepOutcome = Infer<typeof stepOutcomeValidator>;

/**
 * Before a step's model calls: hold the message when a paid step has no
 * headroom (the scan is never held up front: its deterministic checks always
 * run), otherwise open the step's row.
 */
export const beginStep = internalMutation({
	args: { inboundMessageId: v.id('inboundMessages'), kind: agentStepKindValidator },
	returns: v.union(
		v.object({ kind: v.literal('held') }),
		v.object({ kind: v.literal('begun'), actionId: v.id('agentActions') })
	),
	handler: async (ctx, args) => {
		if (isTeamPaidStep(args.kind) && args.kind !== 'security_scan') {
			const { isHeld } = await holdForBudget(ctx, {
				inboundMessageId: args.inboundMessageId,
				step: args.kind,
			});
			if (isHeld) return { kind: 'held' as const };
		}
		const actionId = await beginStepAction(ctx, args.inboundMessageId, args.kind);
		return { kind: 'begun' as const, actionId };
	},
});

/**
 * After a step's model calls: record what it came to and schedule what comes
 * next. A transition the lifecycle rejects (an illegal edge, a terminal state,
 * a vanished message: a concurrent archive or block-sender won the race)
 * fails the step's row and schedules nothing; it is never re-transitioned to
 * `failed`, which would clobber a legitimate terminal win.
 */
export const commitStep = internalMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		kind: agentStepKindValidator,
		actionId: v.id('agentActions'),
		outcome: stepOutcomeValidator,
	},
	returns: v.union(
		v.literal('continued'),
		v.literal('ended'),
		v.literal('rejected'),
		v.literal('failed'),
		v.literal('held')
	),
	handler: async (ctx, { inboundMessageId, kind, actionId, outcome }) => {
		switch (outcome.kind) {
			case 'in_state':
			case 'done': {
				await endStepAction(ctx, {
					actionId,
					output: outcome.output,
					durationMs: outcome.durationMs,
					modelUsed: outcome.modelUsed,
					tokenUsage: outcome.tokenUsage,
				});
				if (outcome.kind === 'done') return 'ended';
				await scheduleAfterCoreStep(ctx, inboundMessageId, kind, outcome.nextStep);
				return 'continued';
			}
			case 'transition': {
				const applied = await applyTransition(ctx, inboundMessageId, outcome.input);
				if (!applied.ok) {
					await failStepAction(
						ctx,
						actionId,
						`transition to ${outcome.input.to} rejected: ${applied.reason}`
					);
					return 'rejected';
				}
				if (!outcome.nextStep) return 'ended';
				await scheduleAfterCoreStep(ctx, inboundMessageId, kind, outcome.nextStep);
				return 'continued';
			}
			case 'refused':
				// The walker sends a refusal only for a paid step; any other is a failure.
				if (isTeamPaidStep(kind)) {
					await holdForBudget(ctx, {
						inboundMessageId,
						step: kind,
						refusedReason: outcome.reason,
						refusedActionId: actionId,
					});
					return 'held';
				}
				await failMessage(ctx, inboundMessageId, actionId, 'Spend admission refused the step');
				return 'failed';
			case 'failed':
				await failMessage(ctx, inboundMessageId, actionId, outcome.errorMessage);
				return 'failed';
		}
	},
});

async function failMessage(
	ctx: MutationCtx,
	inboundMessageId: Id<'inboundMessages'>,
	actionId: Id<'agentActions'>,
	errorMessage: string
): Promise<void> {
	await applyTransition(ctx, inboundMessageId, {
		to: 'failed',
		at: Date.now(),
		errorMessage,
		failingActionId: actionId,
	});
}
