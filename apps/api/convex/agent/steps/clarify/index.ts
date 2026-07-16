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
 * ordered final gate registry; nothing here can make them auto-sendable.
 */

import { internal } from '../../../_generated/api';
import { resolveLanguageModel } from '../../../lib/llmProvider';
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
import { detectAttachmentClarification } from './attachment';
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
	/** Questions that a stored standing answer (answer-memory) resolved silently,
	 * carried through with their answer prefilled (`source: 'memory'`) so the
	 * resumed / direct draft folds them in as confirmed facts WITHOUT re-asking.
	 * See inbox/clarificationMemory.ts. */
	memoryAnswers: ClarificationQuestion[];
	/** Why the expensive check was skipped / how it resolved — observability
	 * only, never drives routing. */
	resolution:
		| 'eagerness_off'
		| 'high_coverage_short_circuit'
		| 'no_candidate_slots'
		| 'converged'
		| 'insufficient_samples'
		| 'questions_emitted'
		| 'memory_filled'
		| 'attachment_ambiguous'
		| 'fail_soft';
};

/**
 * Render the memory-filled answers as the TRUSTED confirmed-facts block the
 * draft step expects (mirrors draft/index.ts buildConfirmedContext). The values
 * come from the owner's own stored answers, never the inbound email, so they are
 * safe to present as authoritative. Pure + exported for tests. Returns '' when
 * there is nothing filled.
 */
export function buildMemoryConfirmedContext(memoryAnswers: ClarificationQuestion[]): string {
	const lines: string[] = [];
	for (const q of memoryAnswers) {
		const value = q.answer?.value?.trim();
		if (value && value.length > 0) lines.push(`- ${q.text.trim()} ${value}`);
	}
	return lines.join('\n');
}

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
			// step's ordered final gate registry), they just aren't asked a question.
			if (!policy.enabled) {
				return { output: { questions: [], memoryAnswers: [], resolution: 'eagerness_off' } };
			}

			// Deterministic attachment-ambiguity ask (model-free), BEFORE the
			// coverage short-circuit and the slot/divergence LLM passes. When the
			// inbound asks for a document and the contact-scoped file match is
			// genuinely ambiguous, park for the owner to pick the right file instead
			// of the agent guessing — the one thing we must never do on attachments.
			// A single confident match yields no question here (the draft step
			// surfaces it as a one-tap suggestion). FAIL-SOFT: any failure → [].
			const attachmentQuestions = await detectAttachmentClarification(ctx, input);
			if (attachmentQuestions.length > 0) {
				return {
					output: {
						questions: attachmentQuestions,
						memoryAnswers: [],
						resolution: 'attachment_ambiguous',
					},
				};
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
						output: {
							questions: [],
							memoryAnswers: [],
							resolution: 'high_coverage_short_circuit',
						},
					};
				}
			}

			const model = await resolveLanguageModel(ctx, 'classify'); // cheap / fast tier
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
					output: { questions: [], memoryAnswers: [], resolution: 'no_candidate_slots' },
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
					output: { questions: [], memoryAnswers: [], resolution: 'insufficient_samples' },
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

			const candidateQuestions = selectQuestions(
				candidateSlots,
				divergenceResult.object.divergentSlotIndexes,
				{ maxQuestions: policy.maxQuestions, highStakesOnly: policy.highStakesOnly }
			);

			// ANSWER-MEMORY: before asking, look up a stored standing answer for each
			// candidate question (scoped to this message's contact + org-general) and
			// fill the slot silently instead of re-asking. Fail-soft: any lookup error
			// → no fills → ask exactly as today. See inbox/clarificationMemory.ts.
			let fills: { questionId: string; value: string }[] = [];
			if (candidateQuestions.length > 0) {
				try {
					const message = await ctx.runQuery(internal.agent.agentPipeline.getMessage, {
						inboundMessageId: input.inboundMessageId,
					});
					const result = await ctx.runMutation(internal.inbox.clarificationMemory.resolveFills, {
						contactId: message?.contactId,
						questions: candidateQuestions.map((q) => ({
							id: q.id,
							slotType: q.slotType,
							text: q.text,
						})),
					});
					fills = result.fills;
				} catch {
					fills = [];
				}
			}
			const fillByQuestion = new Map(fills.map((f) => [f.questionId, f.value] as const));
			const filledAt = Date.now();
			const memoryAnswers: ClarificationQuestion[] = [];
			const questions: ClarificationQuestion[] = [];
			for (const q of candidateQuestions) {
				const value = fillByQuestion.get(q.id);
				if (value !== undefined) {
					memoryAnswers.push({
						...q,
						answer: { value, source: 'memory', at: filledAt },
					});
				} else {
					questions.push(q);
				}
			}

			// Instrument only the questions we ACTUALLY ask (memory-filled ones are
			// not asks). Isolated so a logging failure never drops the questions or
			// wedges the walker.
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
					memoryAnswers,
					resolution:
						questions.length > 0
							? 'questions_emitted'
							: memoryAnswers.length > 0
								? 'memory_filled'
								: 'converged',
				},
				tokenUsage,
				modelUsed,
			};
		} catch {
			// Fail-soft: degrade to today's behaviour (draft), never block.
			return { output: { questions: [], memoryAnswers: [], resolution: 'fail_soft' } };
		}
	},

	route(output, input, runCtx) {
		const memoryAnswers = output.memoryAnswers ?? [];

		// Missing info still remains → park for a human answer. The memory-filled
		// questions (already answered from stored standing answers) ride along
		// pre-answered so the resumed draft folds them in as confirmed facts too —
		// the owner is only asked the questions memory could NOT resolve. The
		// walker stamps `askedAt` from the transition time; classification rides
		// along so the resume path can reconstruct the draft input.
		if (output.questions.length > 0) {
			return {
				kind: 'transition',
				transition: {
					to: 'awaiting_clarification',
					questions: [...memoryAnswers, ...output.questions],
					classification: input.classification,
				},
			};
		}

		// Nothing left to ask → drafting, exactly as classify did before. When
		// answer-memory silently resolved every open slot, thread those confirmed
		// facts straight into the draft (as a TRUSTED block) so the reply uses them
		// even though we never parked for a human.
		const confirmedContext = buildMemoryConfirmedContext(memoryAnswers);
		return {
			kind: 'transition',
			transition: { to: 'drafting', classification: input.classification },
			nextStep: {
				kind: 'draft',
				input: {
					inboundMessageId: runCtx.inboundMessageId,
					context: input.context,
					classification: input.classification,
					...(confirmedContext.length > 0 ? { confirmedContext } : {}),
				},
			},
		};
	},
};
