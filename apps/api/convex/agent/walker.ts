'use node';

/**
 * Agent walker — see CONTEXT.md "Agent walker" and ADR-0014.
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
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { stepModuleFor } from './steps';
import {
	agentStepKindValidator,
	isPluginAgentStepKind,
	pluginStepsFollowing,
} from './steps/catalog';
import { contextRetrievalStep } from './steps/context_retrieval';
import { buildConfirmedContext } from './steps/draft';
import type {
	AgentRoute,
	AgentRunContext,
	AgentStepKind,
	AgentStepResult,
	RouteTransition,
} from './steps/types';
import type { NextStep } from './steps/types';
import { runHostedPluginStep } from './hostedStepRunner';

const continuationValidator = v.object({ kind: agentStepKindValidator, input: v.any() });

interface PluginStepContinuation {
	readonly remainingPluginSteps: readonly AgentStepKind[];
	readonly coreStep?: NextStep;
}

/**
 * Walker-assembled lifecycle TransitionInput. Adds the bookkeeping
 * fields (`at`, `completedActionId`, `output`, `durationMs`,
 * `modelUsed`, `tokenUsage`) to the domain-only fields the module's
 * `route` returned.
 *
 * The variant arms here mirror the lifecycle's TransitionInput
 * validator. Variants that the LLM bookkeeping fields don't apply to
 * (quarantined, archived) get only `output` / `durationMs`.
 */
function assembleTransition(
	routeT: RouteTransition,
	actionId: Id<'agentActions'>,
	result: AgentStepResult<unknown>,
	durationMs: number
) {
	const at = Date.now();
	const output = JSON.stringify(result.output);

	switch (routeT.to) {
		case 'security_check':
			return { to: 'security_check' as const, at };
		case 'classifying':
			return {
				to: 'classifying' as const,
				at,
				completedActionId: actionId,
				output,
				durationMs,
				modelUsed: result.modelUsed,
				tokenUsage: result.tokenUsage,
				securityFlags: routeT.securityFlags,
				contextTier: routeT.contextTier,
			};
		case 'drafting':
			return {
				to: 'drafting' as const,
				at,
				completedActionId: actionId,
				output,
				durationMs,
				modelUsed: result.modelUsed,
				tokenUsage: result.tokenUsage,
				classification: routeT.classification,
			};
		case 'awaiting_clarification':
			return {
				to: 'awaiting_clarification' as const,
				at,
				completedActionId: actionId,
				output,
				durationMs,
				modelUsed: result.modelUsed,
				tokenUsage: result.tokenUsage,
				// The clarify step returns the questions; the walker stamps
				// `askedAt` from the transition time so `route` stays pure.
				pendingClarification: { questions: routeT.questions, askedAt: at },
				classification: routeT.classification,
			};
		case 'draft_ready':
			return {
				to: 'draft_ready' as const,
				at,
				completedActionId: actionId,
				output,
				durationMs,
				modelUsed: result.modelUsed,
				tokenUsage: result.tokenUsage,
				classification: routeT.classification,
				draftResponse: routeT.draftResponse,
				draftSubject: routeT.draftSubject,
				confidenceScore: routeT.confidenceScore,
			};
		case 'quarantined':
			return {
				to: 'quarantined' as const,
				at,
				completedActionId: actionId,
				output,
				durationMs,
				securityFlags: routeT.securityFlags,
			};
		case 'archived':
			return {
				to: 'archived' as const,
				at,
				completedActionId: actionId,
				output,
				durationMs,
				reason: routeT.reason,
				securityFlags: routeT.securityFlags,
			};
		case 'approved':
			return {
				to: 'approved' as const,
				at,
				completedActionId: actionId,
				output,
				source: routeT.source,
				userId: routeT.userId,
			};
	}
}

async function loadRunContext(
	ctx: ActionCtx,
	inboundMessageId: Id<'inboundMessages'>
): Promise<AgentRunContext> {
	const agentConfig = await ctx.runQuery(internal.agent.agentPipeline.getAgentConfig, {});
	return { inboundMessageId, agentConfig };
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
 * Resume a clarification-parked message back INTO the draft step.
 *
 * Two callers, both after the lifecycle has already moved the message
 * `awaiting_clarification → drafting`:
 *   - `inbox.answerClarification` — the owner answered; the confirmed answers
 *     are folded in as a TRUSTED `[CONFIRMED BY OWNER]` block.
 *   - `processingLifecycle.reconcileAbandonedClarifications` — the fallback
 *     cron gave up after the window; the questions are unanswered so the block
 *     is empty and the draft is a best-guess (the route step's safety gate
 *     refuses to auto-send it because `isAutoSendBlocked` is set).
 *
 * Re-enters the DRAFT step specifically (not the whole tail): it rebuilds the
 * retrieval context, folds in the confirmed answers, and schedules the draft
 * step, which then hands off to `route` as usual.
 *
 * FAIL-SOFT: a vanished message, a message no longer in `drafting` (a racing
 * transition won), or a context-retrieval failure never wedges anything — it
 * either returns quietly or drafts on an empty base context.
 */
export const resumeDraft = internalAction({
	args: { inboundMessageId: v.id('inboundMessages') },
	handler: async (ctx, args) => {
		const message = await ctx.runQuery(internal.agent.agentPipeline.getMessage, {
			inboundMessageId: args.inboundMessageId,
		});
		// Only resume a message the lifecycle has already moved into `drafting`.
		// If it's not there (already resumed, dismissed, or vanished), do nothing —
		// re-running the draft step against a stale state would produce an illegal
		// edge downstream.
		if (!message || message.processingStatus !== 'drafting') return;

		// Rebuild the retrieval briefing. FAIL-SOFT: if retrieval throws, draft on
		// an empty base context rather than wedging the message in `drafting`.
		let context = '';
		try {
			const retrieval = await contextRetrievalStep.execute(ctx, {
				inboundMessageId: args.inboundMessageId,
			});
			context = retrieval.output.context;
		} catch {
			context = '';
		}

		// Fold the owner-confirmed answers into a trusted block (empty for the
		// abandoned-question fallback path — an unanswered best-guess).
		const confirmedContext = buildConfirmedContext(message.pendingClarification);

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

		await scheduleAfterCoreStep(ctx, args.inboundMessageId, 'clarify', {
			kind: 'draft',
			input: {
				inboundMessageId: args.inboundMessageId,
				context,
				classification,
				confirmedContext,
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
