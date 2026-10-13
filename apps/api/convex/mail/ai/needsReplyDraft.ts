'use node';

/**
 * The starter reply for an answered Reply Queue clarification card (the body of
 * `needsReplyClassify.draftWithAnswers`, split out to keep that file under the
 * size cap).
 *
 * Drafts through the SHARED draft service (agent/shared/draftService.ts,
 * surface 'personal') with the knowledge recall tool, exactly like the team
 * pipeline's resumed draft: the owner's answers go in as the trusted
 * `[CONFIRMED BY OWNER]` block outside the untrusted email tags, the assembled
 * transcript is re-scanned for injection, and the model may fetch a missing
 * fact from the sender's contact knowledge instead of inventing it. Only the
 * body lands on the card (`clarification.draft`); the quality score and any
 * alternative drafts are not stored there.
 *
 * Unless the owner chose "Draft with what I have", a draft that still has
 * gaps is not stored: each gap becomes a new question on the card
 * (mail/ai/gapQuestions.ts), and answering it writes the draft again.
 */

import type { Id } from '../../_generated/dataModel';
import type { ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { resolveLanguageModel } from '../../lib/llmProvider';
import { runLlmText } from '../../lib/llm/dispatch';
import { stripLeakedToolMarkup } from '../../lib/llm/toolMarkup';
import { meterLlmCall } from '../../analytics/meteredSpend';
import { postboxRoot } from '../../lib/llm/requestMeter';
import { boundedRoot } from '../../lib/llm/actionDeadline';
import { logError } from '../../lib/runtimeLog';
import {
	buildConfirmedContext,
	buildDraftMessages,
	buildDraftSystemPrompt,
	runSharedDraft,
} from '../../agent/shared/draftService';
import { buildRecallKnowledgeTool, MAX_RECALL_CALLS } from '../../agent/steps/draft/recall';
import {
	MAX_CLARIFICATION_DRAFT_CHARS,
	buildOpenFileNote,
	buildOpenQuestionNote,
	joinConfirmedBlocks,
} from '../../inbox/clarificationAnswers';
import { fitGapPlaceholders } from './composeDraftPolicy';
import { checkDraftGaps } from './gapQuestions';
import { localizeReplyQueueQuestions } from './needsReplyRefine';
import {
	measureDraftDelta,
	predictedAskValue,
	shouldSampleDraftDelta,
} from '../../inbox/askEagerness';
import { formatVoiceSection, loadVoiceGuidance } from './voiceGuidance';
import { loadThreadPlan } from './composeDraftPlan';
import { rethrowAdmissionRefusal } from '../../analytics/backgroundDeferral';

const TONE_INSTRUCTION =
	'\n\nTone: match the owner’s natural, personal style — warm and direct, not corporate.';

// Personal mail has no classifier; the shared block's neutral vocabulary.
const CLASSIFICATION = {
	category: 'other',
	intent: 'question',
	sentiment: 'neutral',
	priority: 'medium',
} as const;

/**
 * Draft the reply from the owner's answers and persist it on the card. FAIL-SOFT:
 * AI off, a stale card, an injection hit or any model failure leaves the answers
 * recorded and no draft; the plain "Draft reply" button still works.
 */
export async function draftClarificationReply(
	ctx: ActionCtx,
	args: { threadId: Id<'mailThreads'> }
): Promise<void> {
	// Same gate as the user-triggered Postbox AI (feature flag + rate limit). A
	// refusal (AI off, rate-limited) is expected and stays silent.
	try {
		await ctx.runMutation(internal.mail.ai.gate.assertAiAllowed, {});
	} catch (error) {
		rethrowAdmissionRefusal(error);
		return;
	}

	try {
		const context = await ctx.runQuery(internal.mail.ai.needsReplyClarify.getClarificationContext, {
			threadId: args.threadId,
		});
		if (!context) return;
		// Nothing answered: only "Draft with what I have" drafts all of it as gaps.
		if (context.answers.length === 0 && !context.isGapsAccepted) return;

		// Personalize to the owner's learned voice (opt-in, fail-soft). No access
		// check: a scheduled internal action for the flagged thread's own mailbox.
		const voiceSection = formatVoiceSection(
			await loadVoiceGuidance(ctx, { mailboxId: context.mailboxId, requireAccess: false })
		);
		const audience = `the mailbox owner (${context.ownerAddress}), answering the last message in the thread, which the other party sent`;

		const confirmedContext = joinConfirmedBlocks(
			buildConfirmedContext({
				questions: context.answers.map((a) => ({ text: a.question, answer: { value: a.answer } })),
			}),
			context.fileNotes,
			buildOpenFileNote(context.fileGaps),
			buildOpenQuestionNote(context.questionGaps)
		);

		// Contact-scoped recall, the same isolation gate as the team draft step:
		// the sender's contact, or org-general knowledge only. Never org-wide.
		// Every model call of this clarification draft groups under the message it answers.
		const root = boundedRoot(ctx, postboxRoot(args.threadId, context.latestMessageId));
		const recallKnowledge = buildRecallKnowledgeTool({
			runAction: ctx.runAction,
			scopeToContact: context.contactId ?? 'org-general-only',
			root,
		});

		// The thread's plan: its open items, an unanswered item-linked slot at `clarify`.
		const plan = await loadThreadPlan(ctx, args.threadId);
		const result = await runSharedDraft(ctx, {
			surface: 'personal',
			resolveModel: () => resolveLanguageModel(ctx, 'mail.draft'),
			audience,
			styleReference: "the owner's",
			context: context.transcript,
			confirmedContext,
			classification: CLASSIFICATION,
			toneInstruction: TONE_INSTRUCTION,
			signatureInstruction: '',
			voiceSection,
			tools: { recallKnowledge },
			maxSteps: MAX_RECALL_CALLS + 2,
			// The service records the draft's spend, on success and on a throw.
			spendLabels: { draft: 'postbox_clarify_draft', selfCheck: 'postbox_clarify_selfcheck' },
			root,
			strategyScope: { mailboxId: context.mailboxId, classification: 'other' },
			...(plan ? { responsePlan: plan.prompt } : {}),
		});

		const body = result.draftBody.trim();
		if (body.length === 0) return;
		// Fitted to the card's limit here, so the stored cut never drops a placeholder.
		const draft = fitGapPlaceholders(
			body,
			[...context.fileGaps, ...context.questionGaps],
			MAX_CLARIFICATION_DRAFT_CHARS
		);

		const guard = {
			threadId: args.threadId,
			expectedLatestMessageId: context.latestMessageId,
			expectedAnsweredAt: context.answeredAt,
		};
		// Gaps the owner did not agree to: ask about them, store nothing.
		// The whole body, before the card's length cut could split a gap.
		const gaps = context.isGapsAccepted
			? ({ kind: 'complete' } as const)
			: checkDraftGaps(body, {
					fromAddress: context.senderAddress,
					existing: context.questionIds.map((id) => ({ id })),
				});
		// A gap no question may ask for (a password): no AI draft for this reply.
		if (gaps.kind === 'unaskable') return;
		if (gaps.kind === 'ask') {
			await ctx.runMutation(internal.mail.ai.needsReplyClarify.askAboutDraftGaps, {
				...guard,
				questions: await localizeReplyQueueQuestions(ctx, gaps.questions, root),
			});
			return;
		}

		await ctx.runMutation(internal.mail.ai.needsReplyClarify.persistClarificationDraft, {
			...guard,
			draft,
		});

		// Ask-outcome instrumentation (isolated + fail-soft): log the predicted
		// value of the ask and — cheaply SAMPLED — whether the owner's answers
		// actually CHANGED the draft (draft-with vs draft-without divergence).
		// Never blocks: the draft above is already persisted.
		try {
			const slotTypes = context.answeredSlotTypes;
			let isDraftChanged: boolean | undefined;
			let draftDivergence: number | undefined;
			if (shouldSampleDraftDelta()) {
				try {
					// The same prompt structure minus the confirmed answers — what Owlat
					// would have drafted WITHOUT asking. No tools: a single cheap pass.
					const baselineModel = await resolveLanguageModel(ctx, 'mail.draft');
					const baseline = await meterLlmCall(
						ctx,
						{ feature: 'postbox_clarify_delta', root },
						(meter) =>
							runLlmText({
								meter,
								model: baselineModel,
								messages: buildDraftMessages({
									systemPrompt: buildDraftSystemPrompt({
										audience,
										styleReference: "the owner's",
										toneInstruction: TONE_INSTRUCTION,
										signatureInstruction: '',
										voiceSection,
										hasRecallTool: false,
									}),
									classification: CLASSIFICATION,
									context: context.transcript,
								}),
								temperature: 0.4,
							})
					);
					// The comparison draft goes through the same markup check as the
					// real one (#1254); markup would read as divergence it is not.
					const baselineDraft = stripLeakedToolMarkup(baseline.text);
					if (baselineDraft.kind !== 'unusable') {
						const delta = measureDraftDelta(draft, baselineDraft.text.trim());
						isDraftChanged = delta.changed;
						draftDivergence = delta.divergence;
					}
				} catch (error) {
					rethrowAdmissionRefusal(error); // Sampling is best-effort, a refusal is not.
				}
			}
			await ctx.runMutation(internal.inbox.clarificationLog.recordClarificationAsk, {
				source: 'reply_queue',
				slotTypes,
				questionCount: slotTypes.length,
				predictedValue: predictedAskValue(slotTypes),
				threadId: args.threadId,
				isDraftChanged,
				draftDivergence,
			});
		} catch {
			// Observability only — never affects the draft or the card.
		}
	} catch (err) {
		rethrowAdmissionRefusal(err);
		// Fail-soft: answers stay recorded; no starter draft is persisted. First
		// line only: a model error can quote the prompt, which quotes mail.
		logError(
			'[needsReplyDraft] draft failed:',
			err instanceof Error ? err.message.split('\n', 1)[0] : 'non-Error thrown'
		);
	}
}
