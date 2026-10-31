/**
 * The walker's commits (`./walker.ts`). The walker makes two writes around a
 * step's model calls, and only two:
 *
 *   - {@link beginStep}, before the calls: the budget hold for a paid step,
 *     or the step's `running` row the rest of the step is recorded against;
 *   - {@link commitStep}, after them: the step's result (what the step
 *     module recorded, its row, the lifecycle transition it routed to, or the
 *     failure or hold it ran into) together with the next `runStep`, so the
 *     next hop exists exactly when the step's result does.
 *
 * A step module's `execute` writes nothing itself: it returns its outputs
 * (the draft, the scan verdict, the agent decision; `./stepWrites.ts`) and
 * `commitStep` applies them. Writes a step module makes on purpose before
 * its result is known are marked `// checkpoint:` where they are made.
 *
 * Resuming a message into its draft commits once too ({@link commitResumeDraft}).
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
	abandonStepAction,
	applyTransition,
	beginStepAction,
	endStepAction,
	failStepAction,
	type StepEnd,
} from '../inbox/processingLifecycle/stepActions';
import { agentStepKindValidator } from './steps/catalog';
import { nextStepValidator, scheduleAfterCoreStep } from './walkerSchedule';
import { resumeDraftPlan } from './walkerTransition';
import { applyStepWrites, isStepCurrent, stepWriteValidator, type StepWrite } from './stepWrites';

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
 * run), otherwise open the step's row. `ranIn` is the status the step begins
 * in, which its commit checks again before it records the step's result.
 */
export const beginStep = internalMutation({
	args: { inboundMessageId: v.id('inboundMessages'), kind: agentStepKindValidator },
	returns: v.union(
		v.object({ kind: v.literal('held') }),
		v.object({
			kind: v.literal('begun'),
			actionId: v.id('agentActions'),
			ranIn: v.optional(v.string()),
		})
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
		const ranIn = (await ctx.db.get(args.inboundMessageId))?.processingStatus;
		return { kind: 'begun' as const, actionId, ...(ranIn !== undefined ? { ranIn } : {}) };
	},
});

/**
 * After a step's model calls: record what it came to and schedule what comes
 * next. A step whose message left `ranIn` or was taken over while it ran
 * records nothing and schedules nothing: its row is abandoned (`stale`). The
 * step module's `writes` land first, as they did when the module wrote them
 * itself; a failed step carries only the writes it failed with
 * (`StepFailure`). A write that moves the message itself (the draft fence's
 * hold) ends the step there. A transition the lifecycle rejects (an illegal
 * edge, a terminal state, a vanished message: a concurrent archive or
 * block-sender won the race) fails the step's row and schedules nothing; it
 * is never re-transitioned to `failed`, which would clobber a legitimate
 * terminal win.
 */
export const commitStep = internalMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		kind: agentStepKindValidator,
		actionId: v.id('agentActions'),
		outcome: stepOutcomeValidator,
		writes: v.optional(v.array(stepWriteValidator)),
		ranIn: v.optional(v.string()),
	},
	returns: v.union(
		v.literal('continued'),
		v.literal('ended'),
		v.literal('rejected'),
		v.literal('failed'),
		v.literal('held'),
		v.literal('stale')
	),
	handler: async (ctx, { inboundMessageId, kind, actionId, outcome, writes, ranIn }) => {
		// A caller of the previous release passes no `ranIn` and no writes.
		if (ranIn !== undefined) {
			const landed = await landStepWrites(ctx, inboundMessageId, ranIn, writes ?? []);
			if (landed.kind === 'stale') {
				await abandonStepAction(ctx, actionId, landed.reason);
				return 'stale';
			}
			if (landed.kind === 'moved') {
				await endStepAction(ctx, { actionId, ...stepEndOf(outcome) });
				return 'ended';
			}
		}
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

type Landing = { kind: 'current' } | { kind: 'moved' } | { kind: 'stale'; reason: string };

/**
 * Land a step's writes if the step is still current: `stale` when the
 * message moved on or was taken over (nothing written), `moved` when a write
 * moved the message itself, else `current`.
 */
async function landStepWrites(
	ctx: MutationCtx,
	inboundMessageId: Id<'inboundMessages'>,
	ranIn: string,
	writes: readonly StepWrite[]
): Promise<Landing> {
	const message = await ctx.db.get(inboundMessageId);
	if (!isStepCurrent(message, ranIn)) {
		const reason =
			message?.manualTakeoverAt !== undefined
				? 'A person took over the reply'
				: 'The message moved on while the step ran';
		return { kind: 'stale', reason };
	}
	if (writes.length === 0) return { kind: 'current' };
	await applyStepWrites(ctx, inboundMessageId, writes);
	const after = await ctx.db.get(inboundMessageId);
	return after?.processingStatus === ranIn ? { kind: 'current' } : { kind: 'moved' };
}

/** The row fields a completed step records, when its outcome carries them. */
function stepEndOf(outcome: StepOutcome): Omit<StepEnd, 'actionId'> {
	if (outcome.kind !== 'in_state' && outcome.kind !== 'done') return {};
	return {
		output: outcome.output,
		durationMs: outcome.durationMs,
		modelUsed: outcome.modelUsed,
		tokenUsage: outcome.tokenUsage,
	};
}

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

/**
 * Resume a `drafting` message into its draft step, after the walker rebuilt
 * its retrieval context: record what that retrieval returned (`writes`, its
 * context tier), then hold the message when the retrieval was refused for
 * budget, go back to asking when a question is still open, or schedule the draft.
 * A message that left `drafting` meanwhile (a racing transition won) is left
 * alone: drafting it would only end in an illegal edge.
 */
export const commitResumeDraft = internalMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		context: v.string(),
		refusedReason: v.optional(budgetHoldValidator.fields.reason),
		writes: v.optional(v.array(stepWriteValidator)),
	},
	returns: v.union(
		v.literal('stale'),
		v.literal('held'),
		v.literal('asked'),
		v.literal('drafting')
	),
	handler: async (ctx, { inboundMessageId, context, refusedReason, writes }) => {
		const message = await ctx.db.get(inboundMessageId);
		if (!message || message.processingStatus !== 'drafting') return 'stale';
		if (writes?.length && isStepCurrent(message, 'drafting')) {
			await applyStepWrites(ctx, inboundMessageId, writes);
		}
		// A refused guard or embedding holds the message, never a blind draft.
		if (refusedReason !== undefined) {
			await holdForBudget(ctx, { inboundMessageId, step: 'draft', refusedReason });
			return 'held';
		}
		const plan = resumeDraftPlan(message, Date.now());
		if (plan.kind === 'ask') {
			await applyTransition(ctx, inboundMessageId, plan.input);
			return 'asked';
		}
		await scheduleAfterCoreStep(ctx, inboundMessageId, 'clarify', {
			kind: 'draft',
			// The owner's answers, files, consent to gaps and its placeholders are
			// read from the stored clarification by the draft step itself
			// (agent/steps/draft/gaps.ts), so every path into it gets them.
			input: { inboundMessageId, context, classification: plan.classification },
		});
		return 'drafting';
	},
});
