'use node';

/**
 * Agent walker — see CONTEXT.md "Agent walker".
 *
 * Owns the per-step execution loop for the agent pipeline:
 *   1. Dispatches to an Agent step (module) by `kind`.
 *   2. Opens the step (`walkerCommit.beginStep`: the budget hold, or the
 *      step's row) and calls `module.execute(ctx, input)`.
 *   3. Commits what `module.route(output, input, runCtx)` decided in one
 *      mutation (`walkerCommit.commitStep`):
 *      - `in_state` → complete the row + schedule the next `runStep`.
 *      - `transition` → the lifecycle transition the route assembled;
 *        optionally schedule the next `runStep`.
 *      - `done` → complete the row, stop.
 *   4. On exception → the same commit fails the message against the row
 *      (or holds it, for a refused paid call).
 *
 * Two entry points:
 *   - `start({ inboundMessageId })` — kicks off at `security_scan`. Called
 *     by `inbox/messages.ts:receiveMessage` on new message and by the
 *     lifecycle's `schedule_pipeline_start` effect on `to: 'received'`
 *     from `release_quarantine` / `cron_retry`.
 *   - `runStep({ inboundMessageId, kind, input })` — self-scheduled
 *     dispatch.
 */

import { v } from 'convex/values';
import { internalAction, type ActionCtx } from '../_generated/server';
import { anchorActionDeadline } from '../lib/llm/actionDeadline';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { stepModuleFor } from './steps';
import { agentStepKindValidator, isPluginAgentStepKind } from './steps/catalog';
import { contextRetrievalStep } from './steps/context_retrieval';
import type { AgentRunContext, AgentStepKind } from './steps/types';
import { routedOutcome } from './walkerTransition';
import type { StepOutcome } from './walkerCommit';
import { nextStepValidator, scheduleAfterPluginStep } from './walkerSchedule';
import { admissionRefusalOf, type AdmissionRefusalData } from '../lib/llm/admissionPort';
import { isTeamPaidStep } from '../aiRouting/teamBudgetHold';
import { runHostedPluginStep } from './hostedStepRunner';
import { GUARD_REQUIRED_ERROR, guardBlocksStep } from './steps/security_scan/disposition';

async function loadRunContext(
	ctx: ActionCtx,
	inboundMessageId: Id<'inboundMessages'>
): Promise<AgentRunContext> {
	const agentConfig = await ctx.runQuery(internal.agent.agentPipeline.getAgentConfig, {});
	return { inboundMessageId, agentConfig };
}

/** Fail the message; a retry restarts the pipeline at the scan, which runs the guard. */
async function failForGuard(ctx: ActionCtx, inboundMessageId: Id<'inboundMessages'>) {
	await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
		inboundMessageId,
		input: { to: 'failed', at: Date.now(), errorMessage: GUARD_REQUIRED_ERROR },
	});
}

/**
 * A step that threw: a paid call admission refused mid-step (another call took
 * the headroom) is the spend-ceiling hold, not a pipeline failure.
 */
function failureOutcome(kind: AgentStepKind, error: unknown): StepOutcome {
	const refusal = admissionRefusalOf(error);
	if (refusal && isTeamPaidStep(kind)) return { kind: 'refused', reason: refusal.reason };
	return { kind: 'failed', errorMessage: error instanceof Error ? error.message : String(error) };
}

/**
 * Public entry point — schedule the pipeline at `security_scan`.
 * Three call sites: `inbox/messages.ts:receiveMessage` on new message
 * arrival, and the lifecycle's `schedule_pipeline_start` effect from
 * `release_quarantine` or `cron_retry`.
 */
export const start = internalAction({
	args: { inboundMessageId: v.id('inboundMessages') },
	handler: async (ctx, args) => {
		// One model budget for this action, from its start.
		anchorActionDeadline(ctx);
		// Advance `received → security_check` before the scan runs. The
		// `security_scan` step's route emits `classifying` / `quarantined` /
		// `archived`, which are legal edges only from `security_check`. Without
		// this transition the step's very first emit is rejected as an illegal
		// edge and the message stalls in `received` — no draft is ever produced.
		const outcome = await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: args.inboundMessageId,
			input: { to: 'security_check', at: Date.now() },
		});
		// Not in `received` (already processing, terminal, or vanished) — a
		// concurrent start or a racing terminal transition won; nothing to do.
		if (!outcome.ok) return;

		await ctx.scheduler.runAfter(0, internal.agent.walker.runStep, {
			inboundMessageId: args.inboundMessageId,
			kind: 'security_scan' as AgentStepKind,
			input: { inboundMessageId: args.inboundMessageId },
		});
	},
});

/**
 * Resume a message back INTO the draft step.
 *
 * Two callers, both after the lifecycle has already moved the message into
 * `drafting`:
 *   - `inbox.answerClarification` — the owner answered. The draft step folds
 *     the stored answers in as a TRUSTED `[CONFIRMED BY OWNER]` block, and a
 *     question left open under "Draft with what I have" as a fixed `[[...]]`
 *     placeholder it keeps in the reply (agent/steps/draft/gaps.ts).
 *   - `inbox.updates.requestReply` — a reader asked for a reply to an update;
 *     there are no questions.
 *
 * A question still open without the owner's consent to gaps (a run answered
 * before that rule) is never drafted around: the message goes back to asking.
 *
 * Re-enters the DRAFT step specifically (not the whole tail): it rebuilds the
 * retrieval context and schedules the draft step (which reads the stored answers)
 * and then hands off to `route` as usual.
 *
 * FAIL-SOFT: a vanished message, a message no longer in `drafting` (a racing
 * transition won, also while the context was rebuilt: the commit checks again),
 * or a context-retrieval failure never wedges anything — it either returns
 * quietly or drafts on an empty base context.
 */
export const resumeDraft = internalAction({
	args: { inboundMessageId: v.id('inboundMessages') },
	handler: async (ctx, args) => {
		// One model budget for this action, from its start.
		anchorActionDeadline(ctx);
		const message = await ctx.runQuery(internal.agent.agentPipeline.getMessage, {
			inboundMessageId: args.inboundMessageId,
		});
		// Only resume a message the lifecycle has already moved into `drafting`.
		// If it's not there (already resumed, dismissed, or vanished), do nothing —
		// re-running the draft step against a stale state would produce an illegal
		// edge downstream.
		if (!message || message.processingStatus !== 'drafting') return;
		// Never draft on a message whose model guard was skipped.
		if (guardBlocksStep(message, 'draft')) {
			await failForGuard(ctx, args.inboundMessageId);
			return;
		}

		// Rebuild the retrieval briefing. FAIL-SOFT: if retrieval throws, draft on
		// an empty base context rather than wedging the message in `drafting`.
		let context = '';
		let refusedReason: AdmissionRefusalData['reason'] | undefined;
		try {
			const retrieval = await contextRetrievalStep.execute(ctx, {
				inboundMessageId: args.inboundMessageId,
			});
			context = retrieval.output.context;
		} catch (error) {
			refusedReason = admissionRefusalOf(error)?.reason;
		}

		await ctx.runMutation(internal.agent.walkerCommit.commitResumeDraft, {
			inboundMessageId: args.inboundMessageId,
			context,
			...(refusedReason ? { refusedReason } : {}),
		});
	},
});

/**
 * Self-scheduled per-step dispatch. The only loop body — calls into the
 * Agent step (module) for `kind`, applies the route, and re-enqueues
 * itself for the next step.
 */
export const runStep = internalAction({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		kind: agentStepKindValidator,
		input: v.any(),
		remainingPluginSteps: v.optional(v.array(agentStepKindValidator)),
		coreStep: v.optional(nextStepValidator),
	},
	handler: async (ctx, args) => {
		// Every model call of this step spends from one action budget.
		anchorActionDeadline(ctx);
		const message = await ctx.runQuery(internal.agent.agentPipeline.getMessage, {
			inboundMessageId: args.inboundMessageId,
		});
		// No step after the scan runs before the model guard has.
		if (guardBlocksStep(message, args.kind)) {
			await failForGuard(ctx, args.inboundMessageId);
			return;
		}
		if (isPluginAgentStepKind(args.kind)) {
			const continuation = {
				remainingPluginSteps: args.remainingPluginSteps ?? [],
				coreStep: args.coreStep,
			};
			try {
				await runHostedPluginStep(
					ctx,
					{ inboundMessageId: args.inboundMessageId, kind: args.kind },
					() => scheduleAfterPluginStep(ctx, args.inboundMessageId, continuation)
				);
			} catch {
				await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
					inboundMessageId: args.inboundMessageId,
					input: {
						to: 'failed',
						at: Date.now(),
						errorMessage: 'Hosted agent step continuation failed',
					},
				});
			}
			return;
		}
		const module = stepModuleFor(args.kind);

		// A person took the reply over (inbox/manualReply.ts): the pipeline stops
		// here rather than draft or route a message someone is already answering.
		// A step already in flight is stopped by the lifecycle instead.
		if (message?.manualTakeoverAt !== undefined) return;

		// At the spend ceiling the message waits for a person before a paid step
		// runs (`aiRouting/teamBudgetHold.ts`); otherwise the step's row opens.
		// checkpoint: the step's row, opened before its model calls: the commit
		// below closes it with the step's result or failure, and a run that dies
		// in between leaves it `running` instead of unrecorded.
		const begun = await ctx.runMutation(internal.agent.walkerCommit.beginStep, {
			inboundMessageId: args.inboundMessageId,
			kind: args.kind,
		});
		if (begun.kind === 'held') return;
		const { actionId } = begun;

		const startedAt = Date.now();
		let outcome: StepOutcome;
		try {
			const runCtx = await loadRunContext(ctx, args.inboundMessageId);
			const result = await module.execute(ctx, args.input);
			const route = module.route(result.output, args.input, runCtx);
			outcome = routedOutcome(route, result, actionId, Date.now() - startedAt);
		} catch (error) {
			outcome = failureOutcome(args.kind, error);
		}
		await ctx.runMutation(internal.agent.walkerCommit.commitStep, {
			inboundMessageId: args.inboundMessageId,
			kind: args.kind,
			actionId,
			outcome,
		});
	},
});
