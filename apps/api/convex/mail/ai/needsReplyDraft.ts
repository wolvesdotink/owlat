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
 */

import type { Id } from '../../_generated/dataModel';
import type { ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { resolveLanguageModel } from '../../lib/llmProvider';
import { runLlmText } from '../../lib/llm/dispatch';
import { recordLlmSpend } from '../../analytics/llmUsage';
import { logError } from '../../lib/runtimeLog';
import {
	buildConfirmedContext,
	buildDraftMessages,
	buildDraftSystemPrompt,
	runSharedDraft,
} from '../../agent/shared/draftService';
import { buildRecallKnowledgeTool, MAX_RECALL_CALLS } from '../../agent/steps/draft/recall';
import { buildOpenFileNote, joinConfirmedBlocks } from '../../inbox/clarificationAnswers';
import { ensureGapPlaceholders } from './composeDraftPolicy';
import {
	measureDraftDelta,
	predictedAskValue,
	shouldSampleDraftDelta,
} from '../../inbox/askEagerness';
import { formatVoiceSection, loadVoiceGuidance } from './voiceGuidance';

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
	} catch {
		return;
	}

	try {
		const context = await ctx.runQuery(internal.mail.ai.needsReplyClarify.getClarificationContext, {
			threadId: args.threadId,
		});
		if (!context || context.answers.length === 0) return;

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
			buildOpenFileNote(context.fileGaps)
		);

		// Contact-scoped recall, the same isolation gate as the team draft step:
		// the sender's contact, or org-general knowledge only. Never org-wide.
		const recallKnowledge = buildRecallKnowledgeTool({
			runAction: ctx.runAction,
			scopeToContact: context.contactId ?? 'org-general-only',
		});

		const result = await runSharedDraft(ctx, {
			surface: 'personal',
			resolveModel: () => resolveLanguageModel(ctx, 'draft'),
			audience,
			styleReference: "the owner's",
			context: context.transcript,
			confirmedContext,
			classification: CLASSIFICATION,
			toneInstruction: TONE_INSTRUCTION,
			signatureInstruction: '',
			voiceSection,
			// The owner answered the open questions and reviews the draft in the
			// composer; review-first alternatives have nowhere to land on the card.
			confidence: 1,
			tools: { recallKnowledge },
			maxSteps: MAX_RECALL_CALLS + 2,
			spendLabels: { selfCheck: 'postbox_clarify_selfcheck', options: 'postbox_clarify_options' },
			strategyScope: { mailboxId: context.mailboxId, classification: 'other' },
		});
		await recordLlmSpend(ctx, 'postbox_clarify_draft', result.tokenUsage, result.modelUsed);

		const body = result.draftBody.trim();
		if (body.length === 0) return;
		const draft = ensureGapPlaceholders(body, context.fileGaps);

		await ctx.runMutation(internal.mail.ai.needsReplyClarify.persistClarificationDraft, {
			threadId: args.threadId,
			expectedLatestMessageId: context.latestMessageId,
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
					const baseline = await runLlmText({
						model: await resolveLanguageModel(ctx, 'draft'),
						messages: buildDraftMessages({
							systemPrompt: buildDraftSystemPrompt({
								audience,
								styleReference: "the owner's",
								toneInstruction: TONE_INSTRUCTION,
								signatureInstruction: '',
								voiceSection,
							}),
							classification: CLASSIFICATION,
							context: context.transcript,
						}),
						temperature: 0.4,
					});
					await recordLlmSpend(
						ctx,
						'postbox_clarify_delta',
						baseline.tokenUsage,
						baseline.modelUsed
					);
					const delta = measureDraftDelta(draft, baseline.text.trim());
					isDraftChanged = delta.changed;
					draftDivergence = delta.divergence;
				} catch {
					// Sampling is best-effort; log the ask without the delta.
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
		// Fail-soft: answers stay recorded; no starter draft is persisted. First
		// line only: a model error can quote the prompt, which quotes mail.
		logError(
			'[needsReplyDraft] draft failed:',
			err instanceof Error ? err.message.split('\n', 1)[0] : 'non-Error thrown'
		);
	}
}
