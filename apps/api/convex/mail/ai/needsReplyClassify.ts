'use node';

/**
 * Reply Queue classification action (see mail/needsReply.ts for the module
 * overview). Runs per-thread, scheduled by inbound ingest or the reconcile
 * cron:
 *
 *   1. Deterministic screen over the newest thread messages
 *      (mail/needsReplyHeuristic.ts). Not a candidate → clears the flag and
 *      finishes (no reply-queue model spend).
 *   2. Candidate → persists the deterministic flag FIRST (source `heuristic`,
 *      urgency `normal`), so a crash or model failure anywhere after this point
 *      still leaves the baseline signal (fail-soft). The baseline keeps the
 *      thread pending: a run that dies before the verdict (an OOM-killed
 *      backend, a restart) is classified again by the reconcile sweep, while
 *      a run that ends without a verdict on purpose (interpretation refused,
 *      failed or skipped, the result not persisting) settles it
 *      (mail/needsReplyPending.ts).
 *   3. Interpretation of the newest inbound message (mail/interpret/run.ts,
 *      SPEC §5 "Postbox") replaces the old reply-intent refinement call: the
 *      one model pass that fills the thread brief also NAMES the message from
 *      the closed reply-intent taxonomy (./replyIntent.ts), with urgency and
 *      any meeting request. The server still decides (`decideNeedsReply`
 *      through mail/interpret/needsReplyProjection.ts), so an FYI or a recap
 *      full of action items cannot promote itself, and an actionable item
 *      alone never implies a reply. Interpretation carries its own gate (the
 *      `ai` flag and the spend ceiling, mail/interpret/gate.ts) and frames the
 *      attacker-controlled body as untrusted data. The result only ever updates
 *      the advisory flag — it never sends or modifies mail.
 *   4. Clarification (whether a good reply misses a fact only the owner has)
 *      runs only when the decision needs a reply, behind the Postbox AI gate
 *      (`ai` flag, advisory budget, rate limit), with answer-memory fills.
 *
 * Delivery also hands over the message it just delivered
 * (`interpretMessageId`): it is interpreted here even when the thread is no
 * Reply Queue candidate (interpretation is wider than the queue), so the
 * delivery pipeline never schedules a second run for it.
 */

import { v, type Infer } from 'convex/values';
import { internalAction, type ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { resolveLanguageModel } from '../../lib/llmProvider';
import { runLlmObject, runLlmText } from '../../lib/llm/dispatch';
import { recordLlmSpend } from '../../analytics/llmUsage';
import { recordSpendOnFailure } from '../../analytics/failedLlmSpend';
import { evaluateNeedsReplyCandidate } from '../needsReplyHeuristic';
import { runInterpretation, type InterpretRunResult } from '../interpret/run';
import {
	needsReplyResultOf,
	projectNeedsReply,
	type LatestInbound,
	type NeedsReplyProjection,
} from '../interpret/needsReplyProjection';
import {
	replySlotsSchema,
	divergenceSchema,
	buildSlotPrompt,
	buildCandidatePrompt,
	buildDivergencePrompt,
	sanitizeClarificationQuestions,
	splitCandidateSlots,
	DIVERGENCE_SAMPLES,
	MIN_SAMPLES_FOR_JUDGMENT,
	type ReplySlot,
} from '../../inbox/clarificationSlots';
import { applyMemoryFills, withAnswerKind } from '../../inbox/clarificationAnswers';
import { draftClarificationReply } from './needsReplyDraft';
import { logError } from '../../lib/runtimeLog';
import type { needsReplyClarificationValidator } from '../../lib/validators/clarification';
import { localizeQuestions } from '../../inbox/clarificationLocalize';

/**
 * The needs-reply inputs of a run, when the model read the message. A failed,
 * skipped or vanished run has none: the heuristic baseline then stands.
 */
function usableProjection(run: InterpretRunResult): NeedsReplyProjection | undefined {
	// A reused extraction reports its stored status (`isReplayed`), so the
	// same rule covers it.
	if (run.status !== 'complete' && run.status !== 'partial') return undefined;
	return run.projection;
}

export const classifyThread = internalAction({
	args: {
		threadId: v.id('mailThreads'),
		// Ingest-time headers of the triggering message — only available on the
		// ingest trigger (none of them are persisted on the row, so the reconcile
		// sweep re-classifies without them and leans on the sender screens).
		precedence: v.optional(v.string()),
		/** RFC 3834 Auto-Submitted. */
		autoSubmitted: v.optional(v.string()),
		/** RFC 2919 List-Id. */
		listId: v.optional(v.string()),
		/** The message delivery just landed (live mail only): interpreted by this run. */
		interpretMessageId: v.optional(v.id('mailMessages')),
	},
	handler: async (ctx, args) => {
		const context = await ctx.runQuery(internal.mail.needsReply.getThreadContext, {
			threadId: args.threadId,
		});
		if (!context) return;

		// Eligibility (live delivery, the ingest-only headers) was snapshotted
		// when delivery enqueued the message (`interpret/enqueue.ts`); a message
		// without a snapshot is skipped by the run and the baseline stands.
		const interpret = (messageId: Id<'mailMessages'>) =>
			runInterpretation(ctx, { source: { kind: 'mail', id: messageId } });
		const interpretDelivered = async (alreadyInterpreted?: Id<'mailMessages'>) => {
			if (args.interpretMessageId && args.interpretMessageId !== alreadyInterpreted) {
				await interpret(args.interpretMessageId);
			}
		};

		const evaluation = evaluateNeedsReplyCandidate({
			ownerAddresses: context.ownerAddresses,
			messages: context.messages,
			precedence: args.precedence,
			autoSubmitted: args.autoSubmitted,
			listId: args.listId,
		});

		if (!evaluation.candidate) {
			await ctx.runMutation(internal.mail.needsReply.applyResult, {
				threadId: args.threadId,
				expectedLatestMessageId: context.latestMessageId,
				needsReply: null,
			});
			await interpretDelivered();
			return;
		}

		const latestInbound = context.messages[evaluation.latestInboundIndex];
		if (!latestInbound) {
			await interpretDelivered();
			return;
		}

		// Persist the deterministic candidate first — the interpretation below is
		// a refinement, and any failure in it must leave this baseline in place.
		// The thread stays pending until the refinement ends: if this run is
		// killed before then, the reconcile sweep runs it again.
		await ctx.runMutation(internal.mail.needsReply.applyResult, {
			threadId: args.threadId,
			expectedLatestMessageId: context.latestMessageId,
			needsReply: {
				messageId: latestInbound.messageId,
				source: 'heuristic',
				urgency: 'normal',
			},
			isBaseline: true,
		});

		// Never throws; a replayed run (the sweep, a retry) hands back the stored
		// projection instead of calling the model again.
		const projection = usableProjection(await interpret(latestInbound.messageId));
		const hasVerdict = projection
			? await applyProjection(ctx, {
					threadId: args.threadId,
					expectedLatestMessageId: context.latestMessageId,
					latestInbound: {
						messageId: latestInbound.messageId,
						fromAddress: latestInbound.fromAddress,
						hasCalendarInvite: latestInbound.hasCalendarInvite,
					},
					projection,
					transcript: context.transcript,
				})
			: false;

		await interpretDelivered(latestInbound.messageId);

		// Every outcome this run saw end without a verdict would only repeat on a
		// retry, so it ends the attempt here. Only a run that never gets this far
		// (killed, timed out) is left pending for the sweep.
		if (!hasVerdict) {
			await ctx.runMutation(internal.mail.needsReplyPending.settlePending, {
				threadId: args.threadId,
				expectedLatestMessageId: context.latestMessageId,
			});
		}
	},
});

/**
 * The interpretation's verdict, written through `applyResult`: the server's
 * decision (`needsReplyResultOf`), plus the clarification when that decision
 * needs a reply. True when the verdict persisted.
 */
async function applyProjection(
	ctx: ActionCtx,
	args: {
		threadId: Id<'mailThreads'>;
		expectedLatestMessageId?: Id<'mailMessages'>;
		latestInbound: LatestInbound;
		projection: NeedsReplyProjection;
		transcript: string;
	}
): Promise<boolean> {
	const { decision } = needsReplyResultOf(args.projection, args.latestInbound);
	// Clarification loop: only when the message genuinely needs a reply do we
	// spend the extra passes deciding whether a good reply is missing a fact
	// only the owner can supply. Self-contained fail-soft (undefined on any
	// error), so a clarification failure never downgrades the verdict.
	const clarification = decision.needsReply
		? await clarifyWithMemory(ctx, {
				transcript: args.transcript,
				fromAddress: args.latestInbound.fromAddress,
			})
		: undefined;
	// A throw here is a real fault (e.g. the result no longer matching the
	// applyResult validator), so log it and keep the heuristic flag. Only the
	// first line: a Convex validation error goes on to print the whole argument,
	// and that carries the ask summary and question text.
	try {
		await projectNeedsReply(ctx, {
			threadId: args.threadId,
			...(args.expectedLatestMessageId
				? { expectedLatestMessageId: args.expectedLatestMessageId }
				: {}),
			latestInbound: args.latestInbound,
			projection: args.projection,
			...(clarification ? { clarification } : {}),
		});
		return true;
	} catch (err) {
		logError(
			'[needsReplyClassify] applyResult failed:',
			err instanceof Error ? err.message.split('\n', 1)[0] : 'non-Error thrown'
		);
		return false;
	}
}

/**
 * {@link refineClarification} behind the Postbox AI gate (`ai` flag, advisory
 * budget, rate limit: the extra passes are model spend interpretation's own
 * gate did not cover), with ANSWER-MEMORY fills: any question a stored
 * standing answer (scoped to this sender's contact, or org-general) already
 * resolves stays on the card with `answer.source = 'memory'`, shown as "last
 * time", so a remembered answer is never used silently. Fail-soft: a refused
 * gate asks nothing; a failed memory lookup asks exactly as before.
 */
async function clarifyWithMemory(
	ctx: ActionCtx,
	opts: { transcript: string; fromAddress: string }
): Promise<ClarificationFlag | undefined> {
	try {
		await ctx.runMutation(internal.mail.ai.gate.assertAiAllowed, {});
	} catch {
		return undefined;
	}
	const clarification = await refineClarification(ctx, opts);
	if (!clarification || clarification.questions.length === 0) return clarification;
	try {
		const { fills } = await ctx.runMutation(internal.inbox.clarificationMemory.resolveFills, {
			fromAddress: opts.fromAddress,
			questions: clarification.questions.map((q) => ({
				id: q.id,
				slotType: q.slotType,
				text: q.text,
			})),
		});
		return {
			...clarification,
			questions: applyMemoryFills(clarification.questions, fills, Date.now()),
		};
	} catch {
		return clarification; // ask as before
	}
}

type SpendCtx = Parameters<typeof recordLlmSpend>[0];

/**
 * The clarification refineClarification produces: the persisted
 * `needsReply.clarification` shape (lib/validators/clarification.ts) before
 * the owner answers, so without `answeredAt` and `draft`.
 */
type ClarificationFlag = Omit<
	Infer<typeof needsReplyClarificationValidator>,
	'answeredAt' | 'draft'
>;

/**
 * Decide whether a good reply to this thread is missing a fact only the owner
 * can supply, and if so return the sanitized clarification questions.
 *
 * REUSES the shared slot taxonomy + prompt module (inbox/clarificationSlots.ts)
 * that the inbound agent `clarify` step uses — no fork. Two stages:
 *   1. cheap-tier slot extraction (the 'summarize' tier) → candidate
 *      slots that are BOTH unanswerable from context AND decision-relevant,
 *      plus every file the reply must carry that the context lacks.
 *   2. capable-tier divergence confirmation (the 'draft' tier), run ONLY
 *      when stage 1 flagged a non-file candidate: sample a few independent
 *      replies and keep only the slots they genuinely disagree on. A
 *      converging slot is a safe assumption and is dropped. A file request
 *      skips this stage (splitCandidateSlots): the samples all "attach" it.
 * Every survivor is deterministically sanitized (credential/OTP solicitations
 * dropped, attributed to the sender). FAIL-SOFT: any error returns undefined so
 * the needs-reply refinement is never downgraded by a clarification failure;
 * a failed divergence stage still asks for the files.
 */
export async function refineClarification(
	ctx: SpendCtx,
	opts: { transcript: string; fromAddress: string }
): Promise<ClarificationFlag | undefined> {
	try {
		// Stage 1 — cheap-tier reply-slot extraction (shared prompt module).
		const slotsResult = await recordSpendOnFailure(
			ctx,
			'postbox_clarify_slots',
			runLlmObject({
				model: await resolveLanguageModel(ctx, 'summarize'),
				schema: replySlotsSchema,
				prompt: buildSlotPrompt(opts.transcript),
				temperature: 0.2,
			})
		);
		await recordLlmSpend(
			ctx,
			'postbox_clarify_slots',
			slotsResult.tokenUsage,
			slotsResult.modelUsed
		);

		const { owed, toJudge } = splitCandidateSlots(slotsResult.object.slots);
		if (owed.length === 0 && toJudge.length === 0) return undefined;

		// Files first: they are what the reply cannot go out without.
		const raw = [...owed, ...(await divergentSlots(ctx, opts.transcript, toJudge))].map((slot) => ({
			slotType: slot.slotType,
			text: slot.question,
			options: slot.options,
		}));
		if (raw.length === 0) return undefined;

		// Deterministic safety filter: drop credential/OTP solicitations, attribute
		// each survivor to the sender ("Owlat will never ask for your password").
		// Each survivor gets the input its slot kind calls for (answerKind).
		const sanitized = sanitizeClarificationQuestions(raw, opts.fromAddress).map(withAnswerKind);
		if (sanitized.length === 0) return undefined;

		// Ask the owner in their own language: translate the surviving questions
		// into every other interface locale. Fail-soft to the English copy.
		const localized = await localizeQuestions(
			await resolveLanguageModel(ctx, 'summarize'),
			sanitized
		);
		if (localized.tokenUsage) {
			await recordLlmSpend(
				ctx,
				'postbox_clarify_localize',
				localized.tokenUsage,
				localized.modelUsed
			);
		}

		return { isNeeded: true, questions: localized.questions, askedAt: Date.now() };
	} catch {
		return undefined;
	}
}

/**
 * Stage 2 of {@link refineClarification}: sample independent replies on the
 * capable tier and keep the candidate slots they genuinely disagree on. Empty
 * when there is nothing to judge, too few samples came back to judge at all
 * (don't invent questions), or the judgment failed.
 */
async function divergentSlots(
	ctx: SpendCtx,
	transcript: string,
	candidates: readonly ReplySlot[]
): Promise<ReplySlot[]> {
	if (candidates.length === 0) return [];
	try {
		const drafts: string[] = [];
		for (let i = 0; i < DIVERGENCE_SAMPLES; i++) {
			try {
				const draft = await runLlmText({
					model: await resolveLanguageModel(ctx, 'draft'),
					prompt: buildCandidatePrompt(transcript),
					temperature: 0.9,
				});
				if (draft.text.trim().length > 0) {
					drafts.push(draft.text);
					await recordLlmSpend(ctx, 'postbox_clarify_diverge', draft.tokenUsage, draft.modelUsed);
				}
			} catch {
				// One failed sample doesn't abort the check — judge on the rest.
			}
		}
		if (drafts.length < MIN_SAMPLES_FOR_JUDGMENT) return [];

		const divergenceResult = await recordSpendOnFailure(
			ctx,
			'postbox_clarify_diverge',
			runLlmObject({
				model: await resolveLanguageModel(ctx, 'draft'),
				schema: divergenceSchema,
				prompt: buildDivergencePrompt([...candidates], drafts),
				temperature: 0.1,
			})
		);
		await recordLlmSpend(
			ctx,
			'postbox_clarify_diverge',
			divergenceResult.tokenUsage,
			divergenceResult.modelUsed
		);
		const divergent = new Set(divergenceResult.object.divergentSlotIndexes);
		return candidates.filter((_, index) => divergent.has(index));
	} catch {
		return [];
	}
}

/**
 * Produce the starter reply for an answered clarification card, so it flips
 * from "Needs your input" to "Draft ready".
 *
 * Scheduled by `mail.needsReplyClarify.answerClarification`. Drafts through the
 * shared draft service with the knowledge recall tool, the same way the team
 * pipeline drafts after its clarification (see ./needsReplyDraft.ts). FAIL-SOFT:
 * any gate/model failure leaves the card with the answers recorded and no
 * starter draft — the plain "Draft reply" button still works.
 */
export const draftWithAnswers = internalAction({
	args: { threadId: v.id('mailThreads') },
	handler: (ctx, args) => draftClarificationReply(ctx, args),
});
