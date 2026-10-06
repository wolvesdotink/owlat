'use node';

/**
 * Answer mode: write the draft once the questions are answered or skipped.
 *
 * One prompt structure with the pipeline drafters: the system prompt and the
 * message array come from the shared draft service (`buildDraftSystemPrompt`,
 * `buildDraftMessages`), so the owner's answers, attached files, promised date,
 * open gaps and own instruction sit in the TRUSTED `[CONFIRMED BY OWNER]` block
 * outside the `<untrusted_email_content>` tags, and the assembled context gets
 * the same injection re-scan before it reaches the model. The model may fetch
 * missing facts through the same contact-scoped `recallKnowledge` tool the
 * inbound agent drafts with.
 *
 * Unlike the pipeline, the owner is watching: the draft streams into an
 * owner-private `aiDraftStreams` buffer the way Revise does
 * (mail/ai/reviseDraft.ts). Nothing here sends; the injection scan of the
 * final text is advisory and flags the buffer.
 *
 * Tool-call markup the model types into its reply instead of calling the tool
 * (#1254) never reaches the editor: the buffer only ever holds the part of the
 * text that cannot be markup (lib/llm/toolMarkup.ts), and text the model wrote
 * before a real tool call is dropped (`finalStepOnly`). A leading markup prefix
 * is cut from the final draft; a draft that is unusable otherwise is written
 * once more without tools, then fails the way any failed draft does.
 */

import { internal } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { resolveLanguageModel } from '../../lib/llmProvider';
import { runLlmStream } from '../../lib/llm/dispatch';
import { stripLeakedToolMarkup, visibleDraftStreamText } from '../../lib/llm/toolMarkup';
import { addTokenUsage } from '../../lib/llm/tokenUsage';
import { partialUsageOf } from '../../lib/llm/partialUsage';
import type { TokenUsage } from '../../agent/steps/types';
import { createThrottledStreamFlusher } from '../../lib/llm/streamFlusher';
import { recordLlmSpend } from '../../analytics/llmUsage';
import { logError } from '../../lib/runtimeLog';
import {
	detectInjection,
	INJECTION_CONFIDENCE_THRESHOLD,
} from '../../agent/steps/security_scan/patterns';
import { buildDraftMessages, buildDraftSystemPrompt } from '../../agent/shared/draftService';
import { buildRecallKnowledgeTool, MAX_RECALL_CALLS } from '../../agent/steps/draft/recall';
import { safeLanguage } from '../../agent/steps/draft/sanitize';
import {
	buildAnswerConfirmedContext,
	ensureGapPlaceholders,
	openGapPlaceholders,
	type AskFileRef,
	type AskQuestion,
} from './composeDraftPolicy';

/** How often partial text is written to the buffer (matches Revise). */
const FLUSH_INTERVAL_MS = 120;

export interface AnswerDraftInput {
	sessionId: Id<'answerAskSessions'>;
	/** Untrusted context (thread transcript or pipeline briefing). */
	context: string;
	/** Who the reply is written for, as the shared system prompt phrases it. */
	audience: string;
	styleReference: string;
	toneInstruction: string;
	signatureInstruction: string;
	voiceSection: string;
	/** The contact's language (ISO code); the reply is written in it. */
	language?: string | undefined;
	contactId?: Id<'contacts'> | undefined;
	questions: readonly AskQuestion[];
	attachedFiles: readonly AskFileRef[];
	fileLabel?: string | undefined;
	followUp?: { value: string; at?: number | undefined } | undefined;
	instruction?: string | undefined;
	/** The owner's IANA zone; the promised day is named on their calendar. */
	timeZone?: string | undefined;
}

/** Settle the session as failed; the composer keeps what the person had. */
async function failSession(
	ctx: ActionCtx,
	sessionId: Id<'answerAskSessions'>,
	errorMessage: string
): Promise<void> {
	await ctx.runMutation(internal.mail.ai.composeDraftStore.updateSession, {
		sessionId,
		status: 'error',
		errorMessage,
	});
}

/**
 * Stream the draft into a fresh buffer on the session and settle the session
 * `ready` (or `error`). Never throws for a model failure.
 */
export async function writeAnswerDraft(ctx: ActionCtx, input: AnswerDraftInput): Promise<void> {
	const streamId: Id<'aiDraftStreams'> = await ctx.runMutation(
		internal.mail.ai.composeDraftStore.openSessionStream,
		{ sessionId: input.sessionId }
	);

	// Same defense-in-depth as runSharedDraft: an assembled context that reads
	// as an injection attempt is not drafted automatically.
	const injection = detectInjection(input.context);
	if (injection.detected && injection.confidence >= INJECTION_CONFIDENCE_THRESHOLD) {
		await ctx.runMutation(internal.mail.draftStreamStore.finalizeDraftStream, {
			streamId,
			text: '',
			status: 'error',
			errorMessage: 'injection_suspected',
		});
		await failSession(
			ctx,
			input.sessionId,
			'This email contains text that tries to instruct the AI, so it was not drafted automatically.'
		);
		return;
	}

	const placeholders = openGapPlaceholders(input.questions, input.fileLabel);
	const confirmedContext = buildAnswerConfirmedContext({
		questions: input.questions,
		attachedFiles: input.attachedFiles,
		gapPlaceholders: placeholders,
		fileLabel: input.fileLabel,
		followUp: input.followUp,
		instruction: input.instruction,
		timeZone: input.timeZone,
	});
	const buildMessages = (hasRecallTool: boolean) =>
		buildDraftMessages({
			systemPrompt: buildDraftSystemPrompt({
				audience: input.audience,
				styleReference: input.styleReference,
				toneInstruction: input.toneInstruction,
				signatureInstruction: input.signatureInstruction,
				voiceSection: input.voiceSection,
				replyLanguage: safeLanguage(input.language),
				hasRecallTool,
			}),
			classification: {
				category: 'other',
				intent: 'question',
				sentiment: 'neutral',
				priority: 'medium',
			},
			context: input.context,
			...(confirmedContext ? { confirmedContext } : {}),
		});

	const stream = createThrottledStreamFlusher({
		intervalMs: FLUSH_INTERVAL_MS,
		patch: (text) =>
			ctx.runMutation(internal.mail.draftStreamStore.appendDraftStream, {
				streamId,
				text: visibleDraftStreamText(text),
			}),
	});
	// Usage of finished attempts not yet in the ledger, settled on every exit:
	// a retry that throws must not lose the attempt before it, and a stream
	// that fails after a finished tool step carries that step's usage (#1256).
	let spent: TokenUsage | undefined;
	let spentModel: string | undefined;
	const settleSpend = async (): Promise<void> => {
		const usage = spent;
		spent = undefined;
		await recordLlmSpend(ctx, 'postbox_answer_draft', usage, spentModel);
	};
	try {
		const model = await resolveLanguageModel(ctx, 'draft');
		const streamDraft = (withTools: boolean) =>
			runLlmStream({
				model,
				messages: buildMessages(withTools),
				...(withTools
					? {
							tools: {
								recallKnowledge: buildRecallKnowledgeTool({
									runAction: ctx.runAction,
									scopeToContact: input.contactId ?? 'org-general-only',
								}),
							},
							maxSteps: MAX_RECALL_CALLS + 2,
						}
					: {}),
				// The result is the draft body: narration before a tool call is not.
				finalStepOnly: true,
				temperature: 0.4,
				abortSignal: stream.signal,
				onTextDelta: stream.onText,
				// The text before the call was just dropped: clear it from the
				// editor now, not at the next throttled write.
				onToolCall: () => stream.flush(true),
			});
		let result = await streamDraft(true);
		let draft = stripLeakedToolMarkup(result.text);
		spent = result.tokenUsage;
		spentModel = result.modelUsed;
		let tokenUsage = result.tokenUsage;
		if (draft.kind === 'unusable' && !result.aborted && !stream.stopRequested) {
			// Typed-out tool markup, not a reply. Clear the editor and write the
			// draft once more without the tool, by a prompt that names none.
			await stream.onText('');
			await stream.flush(true);
			result = await streamDraft(false);
			draft = stripLeakedToolMarkup(result.text);
			tokenUsage = addTokenUsage(tokenUsage, result.tokenUsage);
			spent = tokenUsage;
			spentModel = result.modelUsed;
		}
		if (draft.kind === 'unusable') {
			logError('[composeDraft] draft was tool-call markup:', draft.reason);
			await settleSpend();
			await ctx.runMutation(internal.mail.draftStreamStore.finalizeDraftStream, {
				streamId,
				text: '',
				status: 'error',
				errorMessage: 'draft_failed',
			});
			await failSession(ctx, input.sessionId, 'The draft could not be written. Try again.');
			return;
		}
		const text = ensureGapPlaceholders(draft.text.trim(), placeholders);
		const outbound = detectInjection(text);
		await ctx.runMutation(internal.mail.draftStreamStore.finalizeDraftStream, {
			streamId,
			text,
			status: 'complete',
			injectionFlagged: outbound.detected && outbound.confidence >= INJECTION_CONFIDENCE_THRESHOLD,
			model: result.modelUsed,
			tokenUsage,
		});
		await settleSpend();
		await ctx.runMutation(internal.mail.ai.composeDraftStore.updateSession, {
			sessionId: input.sessionId,
			status: 'ready',
		});
	} catch (error) {
		logError(
			'[composeDraft] drafting failed:',
			error instanceof Error ? error.message.split('\n', 1)[0] : 'non-Error thrown'
		);
		const partial = partialUsageOf(error);
		if (partial) {
			spent = addTokenUsage(spent, partial.tokenUsage);
			spentModel = partial.modelUsed ?? spentModel;
		}
		await settleSpend().catch(() => undefined);
		await ctx.runMutation(internal.mail.draftStreamStore.finalizeDraftStream, {
			streamId,
			text: visibleDraftStreamText(stream.text).trim(),
			status: 'error',
			errorMessage: 'draft_failed',
		});
		await failSession(ctx, input.sessionId, 'The draft could not be written. Try again.');
	}
}
