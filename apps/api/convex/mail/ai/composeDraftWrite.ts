'use node';

/**
 * Answer mode: write the draft once the questions are answered or skipped.
 *
 * The same writer as the pipeline drafters: the shared draft service
 * (`runSharedDraft`, agent/shared/draftService.ts) builds the prompt, so the
 * owner's answers, attached files, promised date, open gaps and own
 * instruction sit in the TRUSTED `[CONFIRMED BY OWNER]` block outside the
 * `<untrusted_email_content>` tags, re-scans the assembled context for
 * injection before it reaches the model, and records every request it makes.
 * The model may fetch missing facts through the same contact-scoped
 * `recallKnowledge` tool the inbound agent drafts with.
 *
 * Unlike the pipeline, the owner is watching: the service streams the draft
 * into an owner-private `aiDraftStreams` buffer the way Revise does
 * (mail/ai/reviseDraft.ts), and runs no self-check, since the owner reviews
 * the draft in the composer. Nothing here sends; the injection scan of the
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
import { visibleDraftStreamText } from '../../lib/llm/toolMarkup';
import { createThrottledStreamFlusher } from '../../lib/llm/streamFlusher';
import { newRootRequest } from '../../lib/llm/requestMeter';
import { boundedRoot } from '../../lib/llm/actionDeadline';
import { logError } from '../../lib/runtimeLog';
import {
	detectInjection,
	INJECTION_CONFIDENCE_THRESHOLD,
} from '../../agent/steps/security_scan/patterns';
import {
	DraftInjectionError,
	DraftUnusableError,
	runSharedDraft,
} from '../../agent/shared/draftService';
import type { PlanPromptItem } from '../interpret/planCheck';
import { buildRecallKnowledgeTool, MAX_RECALL_CALLS } from '../../agent/steps/draft/recall';
import { safeLanguage } from '../../agent/steps/draft/sanitize';
import {
	buildAnswerConfirmedContext,
	ensureGapPlaceholders,
	openGapPlaceholders,
	type AskFileRef,
	type AskQuestion,
} from './composeDraftPolicy';
import { admissionRefusalOf, budgetRefusalMessage } from '../../lib/llm/admissionPort';
import { AI_BUDGET_ERROR_CODE } from '@owlat/shared/aiRouting';

/** How often partial text is written to the buffer (matches Revise). */
const FLUSH_INTERVAL_MS = 120;

/** Answer mode has no classifier verdict of its own: the shared block's neutral one. */
const ANSWER_CLASSIFICATION = {
	category: 'other',
	intent: 'question',
	sentiment: 'neutral',
	priority: 'medium',
} as const;

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
	/** The thread's open items with the owner's stances (SPEC §6). */
	responsePlan?: readonly PlanPromptItem[] | undefined;
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

/** Finalize the buffer as failed with `text`, then the session. */
async function failDraft(
	ctx: ActionCtx,
	input: AnswerDraftInput,
	streamId: Id<'aiDraftStreams'>,
	failure: { text: string; errorMessage: string; sessionMessage: string }
): Promise<void> {
	await ctx.runMutation(internal.mail.draftStreamStore.finalizeDraftStream, {
		streamId,
		text: failure.text,
		status: 'error',
		errorMessage: failure.errorMessage,
	});
	await failSession(ctx, input.sessionId, failure.sessionMessage);
}

const DRAFT_FAILED = 'The draft could not be written. Try again.';

/**
 * Stream the draft into a fresh buffer on the session and settle the session
 * `ready` (or `error`). Never throws for a model failure.
 */
export async function writeAnswerDraft(ctx: ActionCtx, input: AnswerDraftInput): Promise<void> {
	const streamId: Id<'aiDraftStreams'> = await ctx.runMutation(
		internal.mail.ai.composeDraftStore.openSessionStream,
		{ sessionId: input.sessionId }
	);

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
	const stream = createThrottledStreamFlusher({
		intervalMs: FLUSH_INTERVAL_MS,
		patch: (text) =>
			ctx.runMutation(internal.mail.draftStreamStore.appendDraftStream, {
				streamId,
				text: visibleDraftStreamText(text),
			}),
	});
	try {
		// The service writes every provider request of both streams (with the
		// recall tool, and the markup retry) to the ledger on every exit (#1256).
		const draft = await runSharedDraft(ctx, {
			surface: 'personal',
			resolveModel: () => resolveLanguageModel(ctx, 'mail.compose'),
			audience: input.audience,
			styleReference: input.styleReference,
			context: input.context,
			...(confirmedContext ? { confirmedContext } : {}),
			classification: ANSWER_CLASSIFICATION,
			toneInstruction: input.toneInstruction,
			signatureInstruction: input.signatureInstruction,
			voiceSection: input.voiceSection,
			tools: (draftCallRoot) => ({
				recallKnowledge: buildRecallKnowledgeTool({
					runAction: ctx.runAction,
					scopeToContact: input.contactId ?? 'org-general-only',
					root: draftCallRoot,
				}),
			}),
			maxSteps: MAX_RECALL_CALLS + 2,
			temperature: 0.4,
			// No self-check label: the owner reviews the draft in the composer.
			spendLabels: { draft: 'postbox_answer_draft' },
			root: boundedRoot(ctx, newRootRequest('postbox_action')),
			replyLanguage: safeLanguage(input.language),
			...(input.responsePlan
				? { responsePlan: { items: input.responsePlan, attachments: [] } }
				: {}),
			stream: {
				signal: stream.signal,
				onText: (full) => stream.onText(full),
				onToolCall: () => stream.flush(true),
				onRetry: async () => {
					await stream.onText('');
					await stream.flush(true);
				},
				isStopRequested: () => stream.stopRequested,
			},
		});
		const text = ensureGapPlaceholders(draft.draftBody.trim(), placeholders);
		const outbound = detectInjection(text);
		await ctx.runMutation(internal.mail.draftStreamStore.finalizeDraftStream, {
			streamId,
			text,
			status: 'complete',
			injectionFlagged: outbound.detected && outbound.confidence >= INJECTION_CONFIDENCE_THRESHOLD,
			model: draft.modelUsed,
			tokenUsage: draft.tokenUsage,
		});
		await ctx.runMutation(internal.mail.ai.composeDraftStore.updateSession, {
			sessionId: input.sessionId,
			status: 'ready',
		});
	} catch (error) {
		// An assembled context that reads as an injection attempt is not drafted
		// automatically (the service's defense-in-depth re-scan).
		if (error instanceof DraftInjectionError) {
			await failDraft(ctx, input, streamId, {
				text: '',
				errorMessage: 'injection_suspected',
				sessionMessage:
					'This email contains text that tries to instruct the AI, so it was not drafted automatically.',
			});
			return;
		}
		// Markup twice over, or cut off at its output ceiling: not a draft.
		if (error instanceof DraftUnusableError) {
			logError('[composeDraft] draft unusable:', error.reason);
			await failDraft(ctx, input, streamId, {
				text: '',
				errorMessage: 'draft_failed',
				sessionMessage: DRAFT_FAILED,
			});
			return;
		}
		logError(
			'[composeDraft] drafting failed:',
			error instanceof Error ? error.message.split('\n', 1)[0] : 'non-Error thrown'
		);
		// D1: a budget refusal says so, with the stable code the web reads.
		const refusal = admissionRefusalOf(error);
		await failDraft(ctx, input, streamId, {
			text: visibleDraftStreamText(stream.text).trim(),
			errorMessage: refusal ? AI_BUDGET_ERROR_CODE : 'draft_failed',
			sessionMessage: refusal ? budgetRefusalMessage(refusal.reason) : DRAFT_FAILED,
		});
	}
}
