'use node';

/**
 * `clarify` Agent step (module) — see ADR-0014.
 *
 * Sits at the classify fork, BETWEEN classify and draft. Its job is to catch
 * the case where the agent is about to reply while missing a fact only the
 * mailbox owner can supply — and to ask a focused question instead of drafting
 * (and possibly auto-sending) a confident guess.
 *
 * Two-stage, cost-gated detection:
 *
 *   1. REPLY SLOTS. One cheap structured pass extracts the typed slots the
 *      reply must fill — a decision, a date/time, a price/number, an
 *      attachment, a stance/tone, or a factual lookup — each tagged with
 *      whether it is answerable from the retrieved context and whether it is
 *      decision-relevant (materially changes the reply). The inbound email is
 *      framed strictly as untrusted DATA (SYSTEM_GUARD).
 *
 *   2. DIVERGENCE. For the slots that are BOTH unanswerable from context AND
 *      decision-relevant, we sample a few candidate replies and ask whether
 *      they DISAGREE on how to fill each slot. A slot the variants diverge on
 *      is a genuine open question; a slot they converge on is a safe assumption
 *      and is dropped. This is the expensive stage, so it is skipped entirely
 *      when the context-coverage signal says the AI is well-grounded (and it is
 *      never reached at all when stage 1 found no candidate slots).
 *
 * Routing:
 *   - one or more open questions  → `awaiting_clarification` (the owner answers
 *     from the review surface; the draft resumes with the confirmed facts).
 *   - nothing missing             → `drafting` (today's behaviour), scheduling
 *     the draft step exactly as classify did before.
 *
 * FAIL-SOFT is sacred: EVERY failure inside `execute` (LLM error, malformed
 * object, missing provider, unreadable coverage) is caught internally and
 * degrades to zero questions → `drafting`. The step never throws (a throw would
 * be translated by the walker into `failed`), never blocks ingest, and never
 * emits a question on uncertainty about its own machinery.
 *
 * Complaint / urgent mail is forked through here too (classify used to skip it
 * straight to a blank human-review box). It runs with CAUTIOUS eagerness — the
 * cheap coverage short-circuit is disabled so the highest-stakes mail always
 * gets the missing-info check. The hard rule that complaint/urgent are NEVER
 * auto-send-eligible is enforced independently in the `route` step's
 * `assertSafeToAutoSend`; nothing here can make them auto-sendable.
 */

import { internal } from '../../../_generated/api';
import { getLLMProvider } from '../../../lib/llmProvider';
import { runLlmObject, runLlmText } from '../../../lib/llm/dispatch';
import type { Id } from '../../../_generated/dataModel';
import type { Infer } from 'convex/values';
import { clarificationQuestionValidator } from '../../../inbox/clarificationValidators';
import {
	DIVERGENCE_SAMPLES,
	MIN_SAMPLES_FOR_JUDGMENT,
	MAX_QUESTIONS,
	replySlotsSchema,
	divergenceSchema,
	buildSlotPrompt,
	buildCandidatePrompt,
	buildDivergencePrompt,
	type ReplySlot,
} from '../../../inbox/clarificationSlots';
import {
	resolveEagernessPolicy,
	isHighStakesSlot,
	predictedAskValue,
	type EagernessMode,
	type EagernessPolicy,
} from '../../../inbox/askEagerness';
import type { AgentStepModule, TokenUsage } from '../types';

// The slot taxonomy + untrusted-data prompt module is SHARED with the personal
// -mail Reply Queue refinement (mail/needsReplyClassify.ts) — see
// inbox/clarificationSlots.ts. Re-exported here so this step's existing tests
// (and any importer of the step) keep their import path.
export {
	buildSlotPrompt,
	buildCandidatePrompt,
	buildDivergencePrompt,
} from '../../../inbox/clarificationSlots';
export type { ReplySlot } from '../../../inbox/clarificationSlots';

export type ClarificationQuestion = Infer<typeof clarificationQuestionValidator>;

export type ClarifyInput = {
	inboundMessageId: Id<'inboundMessages'>;
	context: string;
	classification: {
		category: string;
		priority: string;
		sentiment: string;
		intent: string;
		confidence: number;
	};
};

export type ClarifyOutput = {
	/** Open questions to park on the message; empty → route to `drafting`. */
	questions: ClarificationQuestion[];
	/** Why the expensive check was skipped / how it resolved — observability
	 * only, never drives routing. */
	resolution:
		| 'eagerness_off'
		| 'high_coverage_short_circuit'
		| 'no_candidate_slots'
		| 'converged'
		| 'insufficient_samples'
		| 'questions_emitted'
		| 'fail_soft';
};

/** Cautious eagerness = the cheap coverage short-circuit is disabled so the
 * missing-info check always runs. Applied to the highest-stakes mail
 * (complaints and anything urgent), which used to skip the drafter entirely. */
export function eagernessForCategory(classification: {
	category: string;
	priority: string;
}): 'cautious' | 'default' {
	if (classification.category === 'complaint' || classification.priority === 'urgent') {
		return 'cautious';
	}
	return 'default';
}

/** How the ask-eagerness dial narrows which divergent slots become questions:
 * a hard per-email cap (batched into one micro-form, never dripped) and an
 * optional high-stakes-only filter. Defaults reproduce today's behaviour. */
export interface QuestionSelectionPolicy {
	maxQuestions: number;
	highStakesOnly: boolean;
}

const DEFAULT_SELECTION_POLICY: QuestionSelectionPolicy = {
	maxQuestions: MAX_QUESTIONS,
	highStakesOnly: false,
};

/**
 * Pure selection of which candidate slots become surfaced questions. Takes the
 * candidate slots and the divergent indexes into that same array, keeps the
 * divergent ones, applies the eagerness policy (high-stakes filter + hard cap),
 * and shapes them into `pendingClarification` question rows with stable ids.
 * The cap is a HARD ceiling: every surviving question is returned in ONE batch,
 * never dripped across replies. Exported for tests. The optional `policy`
 * defaults to today's behaviour (cap {@link MAX_QUESTIONS}, no filter).
 */
export function selectQuestions(
	candidateSlots: ReplySlot[],
	divergentIndexes: readonly number[],
	policy: QuestionSelectionPolicy = DEFAULT_SELECTION_POLICY
): ClarificationQuestion[] {
	const cap = Math.min(policy.maxQuestions, MAX_QUESTIONS);
	if (cap <= 0) return [];
	const divergent = new Set(divergentIndexes);
	const questions: ClarificationQuestion[] = [];
	for (let i = 0; i < candidateSlots.length; i++) {
		if (!divergent.has(i)) continue;
		const slot = candidateSlots[i]!;
		// Confident eagerness only surfaces genuinely high-stakes slots
		// (money / commitment / date / legal-tone); routine acks are dropped.
		if (policy.highStakesOnly && !isHighStakesSlot(slot.slotType)) continue;
		questions.push({
			id: `clarify_${i}`,
			slotType: slot.slotType,
			text: slot.question,
		});
		if (questions.length >= cap) break;
	}
	return questions;
}

/** Sum two optional token-usage records for aggregate step observability. */
function addUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
	if (!a) return b;
	if (!b) return a;
	return {
		promptTokens: a.promptTokens + b.promptTokens,
		completionTokens: a.completionTokens + b.completionTokens,
		totalTokens: a.totalTokens + b.totalTokens,
	};
}

export const clarifyStep: AgentStepModule<'clarify', ClarifyInput, ClarifyOutput> = {
	kind: 'clarify',
	llm: { tier: 'fast' },

	async execute(ctx, input) {
		// FAIL-SOFT ENVELOPE: any failure inside collapses to zero questions →
		// drafting (today's behaviour). The step never throws.
		try {
			const categoryCautious = eagernessForCategory(input.classification) === 'cautious';

			// Read the ask-eagerness dial (session-less). Fail-soft: any read error
			// → undefined mode → today's behaviour.
			let mode: EagernessMode | undefined;
			try {
				const setting = await ctx.runQuery(
					internal.inbox.askEagernessSettings.getAskEagernessInternal,
					{}
				);
				mode = setting.mode ?? undefined;
			} catch {
				mode = undefined;
			}
			const policy: EagernessPolicy = resolveEagernessPolicy(mode, { categoryCautious });

			// Dial set to Off → never ask; draft for human review (today's
			// pre-clarify behaviour minus the ask). Category can't override Off here:
			// complaint/urgent are still forced to HUMAN REVIEW downstream (the route
			// step's assertSafeToAutoSend), they just aren't asked a question.
			if (!policy.enabled) {
				return { output: { questions: [], resolution: 'eagerness_off' } };
			}

			// Cheap coverage short-circuit — skip the whole (expensive) pass when
			// the retrieval briefing is well-grounded, UNLESS the policy forces the
			// check (complaint/urgent, or a cautious dial). `contextCoverage` is the
			// advisory signal the context_retrieval step persisted on the message.
			if (!policy.forceCheck) {
				const message = await ctx.runQuery(internal.agent.agentPipeline.getMessage, {
					inboundMessageId: input.inboundMessageId,
				});
				const coverage = message?.contextCoverage;
				if (coverage && !coverage.lowCoverage) {
					return {
						output: { questions: [], resolution: 'high_coverage_short_circuit' },
					};
				}
			}

			const model = getLLMProvider('classify'); // cheap / fast tier
			let tokenUsage: TokenUsage | undefined;
			let modelUsed: string | undefined;

			// Stage 1 — extract typed reply slots.
			const slotsResult = await runLlmObject({
				model,
				schema: replySlotsSchema,
				prompt: buildSlotPrompt(input.context),
				temperature: 0.2,
			});
			tokenUsage = addUsage(tokenUsage, slotsResult.tokenUsage);
			modelUsed = slotsResult.modelUsed;

			// Candidate slots: the ones we actually need to ask about — unanswerable
			// from context AND decision-relevant. A converging assumption on an
			// answerable/irrelevant slot is not worth a question.
			const candidateSlots: ReplySlot[] = [];
			for (const slot of slotsResult.object.slots) {
				if (!slot.answerableFromContext && slot.decisionRelevant) {
					candidateSlots.push(slot);
				}
			}
			if (candidateSlots.length === 0) {
				return {
					output: { questions: [], resolution: 'no_candidate_slots' },
					tokenUsage,
					modelUsed,
				};
			}

			// Stage 2 — divergence check. Sample a few candidate replies; a slot the
			// variants disagree on is a real question, one they converge on is a safe
			// assumption to drop.
			const drafts: string[] = [];
			for (let i = 0; i < DIVERGENCE_SAMPLES; i++) {
				try {
					const draft = await runLlmText({
						model,
						prompt: buildCandidatePrompt(input.context),
						// High temperature so independent samples actually diverge where
						// the answer is genuinely open.
						temperature: 0.9,
					});
					if (draft.text.trim().length > 0) {
						drafts.push(draft.text);
						tokenUsage = addUsage(tokenUsage, draft.tokenUsage);
					}
				} catch {
					// One failed sample doesn't abort the check — we judge on the rest.
				}
			}

			if (drafts.length < MIN_SAMPLES_FOR_JUDGMENT) {
				// Can't judge divergence → don't invent questions; draft as today.
				return {
					output: { questions: [], resolution: 'insufficient_samples' },
					tokenUsage,
					modelUsed,
				};
			}

			const divergenceResult = await runLlmObject({
				model,
				schema: divergenceSchema,
				prompt: buildDivergencePrompt(candidateSlots, drafts),
				temperature: 0.1,
			});
			tokenUsage = addUsage(tokenUsage, divergenceResult.tokenUsage);

			const questions = selectQuestions(
				candidateSlots,
				divergenceResult.object.divergentSlotIndexes,
				{ maxQuestions: policy.maxQuestions, highStakesOnly: policy.highStakesOnly }
			);

			// Instrument the ask (predicted value + dial position) so thresholds can
			// calibrate on real outcomes. Isolated so a logging failure never drops
			// the questions or wedges the walker.
			if (questions.length > 0) {
				try {
					const slotTypes = questions.map((q) => q.slotType);
					await ctx.runMutation(internal.inbox.clarificationLog.recordClarificationAsk, {
						source: 'agent',
						slotTypes,
						questionCount: questions.length,
						predictedValue: predictedAskValue(slotTypes),
						eagerness: mode,
					});
				} catch {
					// Observability only — never let it affect routing.
				}
			}

			return {
				output: {
					questions,
					resolution: questions.length > 0 ? 'questions_emitted' : 'converged',
				},
				tokenUsage,
				modelUsed,
			};
		} catch {
			// Fail-soft: degrade to today's behaviour (draft), never block.
			return { output: { questions: [], resolution: 'fail_soft' } };
		}
	},

	route(output, input, runCtx) {
		// Missing info → park for a human answer. The walker stamps `askedAt` from
		// the transition time; classification rides along so the resume path can
		// reconstruct the draft input.
		if (output.questions.length > 0) {
			return {
				kind: 'transition',
				transition: {
					to: 'awaiting_clarification',
					questions: output.questions,
					classification: input.classification,
				},
			};
		}

		// Nothing missing → drafting, exactly as classify did before: transition
		// to `drafting` (carrying classification) and schedule the draft step with
		// the same context.
		return {
			kind: 'transition',
			transition: { to: 'drafting', classification: input.classification },
			nextStep: {
				kind: 'draft',
				input: {
					inboundMessageId: runCtx.inboundMessageId,
					context: input.context,
					classification: input.classification,
				},
			},
		};
	},
};
