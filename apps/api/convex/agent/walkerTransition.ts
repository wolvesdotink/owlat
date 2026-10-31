/**
 * The walker's step outcome and lifecycle TransitionInput assembly, split out
 * of `./walker.ts` to hold it under the size cap.
 */

import type { Doc, Id } from '../_generated/dataModel';
import { hasUsableAnswer } from '../inbox/clarificationAnswers';
import type { TransitionInput } from '../inbox/processingLifecycle/types';
import type { AgentRoute, AgentStepResult, RouteTransition } from './steps/types';
import type { StepOutcome } from './walkerCommit';

/**
 * What resuming a `drafting` message comes to: the draft, or back to asking
 * when a question is still open without the owner's consent to gaps (a run
 * answered before that rule), which is never drafted around.
 */
export function resumeDraftPlan(
	message: Pick<Doc<'inboundMessages'>, 'pendingClarification' | 'classification'>,
	at: number
):
	| {
			readonly kind: 'ask';
			readonly input: Extract<TransitionInput, { to: 'awaiting_clarification' }>;
	  }
	| {
			readonly kind: 'draft';
			readonly classification: NonNullable<Doc<'inboundMessages'>['classification']>;
	  } {
	const pending = message.pendingClarification;
	const questions = pending?.questions ?? [];
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
	if (pending && pending.isGapsAccepted !== true && !questions.every(hasUsableAnswer)) {
		return {
			kind: 'ask',
			input: {
				to: 'awaiting_clarification',
				at,
				pendingClarification: { questions, askedAt: at },
				classification,
			},
		};
	}
	return { kind: 'draft', classification };
}

/** What a step that ran to its route came to, for the walker's step commit. */
export function routedOutcome(
	route: AgentRoute,
	result: AgentStepResult<unknown>,
	actionId: Id<'agentActions'>,
	durationMs: number
): StepOutcome {
	switch (route.kind) {
		case 'in_state':
			return { kind: 'in_state', ...stepEnd(result, durationMs), nextStep: route.nextStep };
		case 'done':
			return { kind: 'done', ...stepEnd(result, durationMs) };
		case 'transition':
			return {
				kind: 'transition',
				input: assembleTransition(route.transition, actionId, result, durationMs),
				...(route.nextStep ? { nextStep: route.nextStep } : {}),
			};
	}
}

function stepEnd(result: AgentStepResult<unknown>, durationMs: number) {
	return {
		output: JSON.stringify(result.output),
		durationMs,
		modelUsed: result.modelUsed,
		tokenUsage: result.tokenUsage,
	};
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
export function assembleTransition(
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
		case 'informational':
			return {
				to: 'informational' as const,
				at,
				completedActionId: actionId,
				output,
				durationMs,
				modelUsed: result.modelUsed,
				tokenUsage: result.tokenUsage,
				classification: routeT.classification,
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
