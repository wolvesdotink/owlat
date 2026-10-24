'use node';

/**
 * Agent walker — see CONTEXT.md "Agent walker".
 *
 * Owns the per-step execution loop for the agent pipeline:
 *   1. Dispatches to an Agent step (module) by `kind`.
 *   2. Calls `module.execute(ctx, input)`.
 *   3. Applies `module.route(output, input, runCtx)`:
 *      - `in_state` → `recordStepEnd` + schedule next `runStep`.
 *      - `transition` → assemble `TransitionInput` and call
 *        `lifecycle.transition`; optionally schedule next `runStep`.
 *      - `done` → `recordStepEnd`, stop.
 *   4. On exception → `lifecycle.transition({ to: 'failed',
 *      failingActionId })`.
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
import {
	agentStepKindValidator,
	isPluginAgentStepKind,
	pluginStepsFollowing,
} from './steps/catalog';
import { contextRetrievalStep } from './steps/context_retrieval';
import { hasUsableAnswer } from '../inbox/clarificationAnswers';
import type {
	AgentRoute,
	AgentRunContext,
	AgentStepKind,
	AgentStepResult,
	NextStep,
} from './steps/types';
import { assembleTransition } from './walkerTransition';
import { admissionRefusalOf, type AdmissionRefusalData } from '../lib/llm/admissionPort';
import { isTeamPaidStep } from '../aiRouting/teamBudgetHold';
import { runHostedPluginStep } from './hostedStepRunner';
import { GUARD_REQUIRED_ERROR, guardBlocksStep } from './steps/security_scan/disposition';

const continuationValidator = v.object({ kind: agentStepKindValidator, input: v.any() });

interface PluginStepContinuation {
	readonly remainingPluginSteps: readonly AgentStepKind[];
	readonly coreStep?: NextStep;
}

async function loadRunContext(
	ctx: ActionCtx,
	inboundMessageId: Id<'inboundMessages'>
): Promise<AgentRunContext> {
	const agentConfig = await ctx.runQuery(internal.agent.agentPipeline.getAgentConfig, {});
	return { inboundMessageId, agentConfig };
}

/** Hold the message for a person when `kind` is a paid step without headroom. */
async function isHeldForBudget(
	ctx: ActionCtx,
	inboundMessageId: Id<'inboundMessages'>,
	kind: AgentStepKind,
	refused?: { refusal: AdmissionRefusalData; actionId?: Id<'agentActions'> }
): Promise<boolean> {
	if (!isTeamPaidStep(kind)) return false;
	// The scan's deterministic checks always run: it is held only on a refusal.
	if (!refused && kind === 'security_scan') return false;
	const { isHeld } = await ctx.runMutation(internal.aiRouting.teamBudgetHold.holdIfOverBudget, {
		inboundMessageId,
		step: kind,
		...(refused ? { refusedReason: refused.refusal.reason } : {}),
		...(refused?.actionId ? { refusedActionId: refused.actionId } : {}),
	});
	return isHeld;
}

/** Fail the message; a retry restarts the pipeline at the scan, which runs the guard. */
async function failForGuard(ctx: ActionCtx, inboundMessageId: Id<'inboundMessages'>) {
	await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
		inboundMessageId,
		input: { to: 'failed', at: Date.now(), errorMessage: GUARD_REQUIRED_ERROR },
	});
}

async function scheduleStep(
	ctx: ActionCtx,
	inboundMessageId: Id<'inboundMessages'>,
	step: NextStep,
	continuation?: PluginStepContinuation
): Promise<void> {
	await ctx.scheduler.runAfter(0, internal.agent.walker.runStep, {
		inboundMessageId,
		kind: step.kind,
		input: step.input,
		remainingPluginSteps: continuation ? [...continuation.remainingPluginSteps] : undefined,
		coreStep: continuation?.coreStep,
	});
}

async function scheduleAfterCoreStep(
	ctx: ActionCtx,
	inboundMessageId: Id<'inboundMessages'>,
	completedKind: AgentStepKind,
	nextStep: NextStep
): Promise<void> {
	const pluginSteps = pluginStepsFollowing(completedKind);
	const [firstPluginStep, ...remainingPluginSteps] = pluginSteps;
	if (!firstPluginStep) {
		await scheduleStep(ctx, inboundMessageId, nextStep);
		return;
	}
	await scheduleStep(
		ctx,
		inboundMessageId,
		{ kind: firstPluginStep, input: { inboundMessageId } },
		{ remainingPluginSteps, coreStep: nextStep }
	);
}

async function scheduleAfterPluginStep(
	ctx: ActionCtx,
	inboundMessageId: Id<'inboundMessages'>,
	continuation: PluginStepContinuation
): Promise<void> {
	const [nextPluginStep, ...remainingPluginSteps] = continuation.remainingPluginSteps;
	if (nextPluginStep) {
		await scheduleStep(
			ctx,
			inboundMessageId,
			{ kind: nextPluginStep, input: { inboundMessageId } },
			{ remainingPluginSteps, coreStep: continuation.coreStep }
		);
		return;
	}
	if (continuation.coreStep) await scheduleStep(ctx, inboundMessageId, continuation.coreStep);
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
 * transition won), or a context-retrieval failure never wedges anything — it
 * either returns quietly or drafts on an empty base context.
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
		try {
			const retrieval = await contextRetrievalStep.execute(ctx, {
				inboundMessageId: args.inboundMessageId,
			});
			context = retrieval.output.context;
		} catch (error) {
			// A refused guard or embedding holds the message, never a blind draft.
			const refusal = admissionRefusalOf(error);
			if (refusal && (await isHeldForBudget(ctx, args.inboundMessageId, 'draft', { refusal }))) {
				return;
			}
			context = '';
		}

		const pending = message.pendingClarification;
		const questions = pending?.questions ?? [];
		const isGapsAccepted = pending?.isGapsAccepted === true;
		// The message went through `classify` to reach `awaiting_clarification`, so
		// its classification is normally present; fall back to a neutral one so the
		// draft can still run.
		const classification = message.classification ?? {
			category: 'other',
			priority: 'normal',
			sentiment: 'neutral',
			intent: 'other',
			confidence: 0,
		};
		if (pending && !isGapsAccepted && !questions.every(hasUsableAnswer)) {
			await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
				inboundMessageId: args.inboundMessageId,
				input: {
					to: 'awaiting_clarification',
					at: Date.now(),
					pendingClarification: { questions, askedAt: Date.now() },
					classification,
				},
			});
			return;
		}

		await scheduleAfterCoreStep(ctx, args.inboundMessageId, 'clarify', {
			kind: 'draft',
			input: {
				inboundMessageId: args.inboundMessageId,
				context,
				// The owner's answers, files, consent to gaps and its placeholders
				// are read from the stored clarification by the draft step itself
				// (agent/steps/draft/gaps.ts), so every path into it gets them.
				classification,
			},
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
		coreStep: v.optional(continuationValidator),
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

		// At the spend ceiling the message waits for a person
		// before a paid step runs (`aiRouting/teamBudgetHold.ts`).
		if (await isHeldForBudget(ctx, args.inboundMessageId, args.kind)) return;

		// Begin the agentAction row up front so a crash inside `execute`
		// still has an actionId to fail.
		const { actionId } = await ctx.runMutation(internal.inbox.processingLifecycle.recordStepBegin, {
			inboundMessageId: args.inboundMessageId,
			actionType: args.kind,
		});

		const startedAt = Date.now();
		let result: AgentStepResult<unknown>;
		let route: AgentRoute;
		try {
			const runCtx = await loadRunContext(ctx, args.inboundMessageId);
			result = await module.execute(ctx, args.input);
			route = module.route(result.output, args.input, runCtx);
		} catch (error) {
			// A paid call admission refused mid-step (another call took the
			// headroom): the same spend-ceiling hold, not a pipeline failure.
			const refusal = admissionRefusalOf(error);
			if (refusal && isTeamPaidStep(args.kind)) {
				await isHeldForBudget(ctx, args.inboundMessageId, args.kind, { refusal, actionId });
				return;
			}
			const errorMessage = error instanceof Error ? error.message : String(error);
			await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
				inboundMessageId: args.inboundMessageId,
				input: {
					to: 'failed',
					at: Date.now(),
					errorMessage,
					failingActionId: actionId,
				},
			});
			return;
		}
		const durationMs = Date.now() - startedAt;

		switch (route.kind) {
			case 'in_state':
				await ctx.runMutation(internal.inbox.processingLifecycle.recordStepEnd, {
					actionId,
					output: JSON.stringify(result.output),
					durationMs,
					modelUsed: result.modelUsed,
					tokenUsage: result.tokenUsage,
				});
				await scheduleAfterCoreStep(ctx, args.inboundMessageId, args.kind, route.nextStep);
				return;

			case 'transition': {
				const transitionInput = assembleTransition(route.transition, actionId, result, durationMs);
				const outcome = await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
					inboundMessageId: args.inboundMessageId,
					input: transitionInput,
				});
				if (!outcome.ok) {
					// The lifecycle rejected the transition (illegal edge, terminal
					// state, or vanished message — e.g. a concurrent archive /
					// block-sender won the race). Close the dangling action and
					// stop. Do NOT re-transition to 'failed' (that would clobber a
					// legitimate terminal win) and do NOT schedule the next step —
					// silently continuing here is exactly what once let a broken
					// entry edge advance the pipeline against a stalled message.
					await ctx.runMutation(internal.inbox.processingLifecycle.recordStepFail, {
						actionId,
						errorMessage: `transition to ${transitionInput.to} rejected: ${outcome.reason}`,
					});
					return;
				}
				if (route.nextStep) {
					await scheduleAfterCoreStep(ctx, args.inboundMessageId, args.kind, route.nextStep);
				}
				return;
			}

			case 'done':
				await ctx.runMutation(internal.inbox.processingLifecycle.recordStepEnd, {
					actionId,
					output: JSON.stringify(result.output),
					durationMs,
					modelUsed: result.modelUsed,
					tokenUsage: result.tokenUsage,
				});
				return;
		}
	},
});
