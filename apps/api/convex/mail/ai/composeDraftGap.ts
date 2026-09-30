'use node';

/**
 * Answer mode gap check: before "Draft with AI" writes a word, find what the
 * reply needs that only the owner knows.
 *
 * Reuses the background clarification machinery rather than forking it:
 *  - the shared slot taxonomy and prompts (inbox/clarificationSlots.ts):
 *    cheap-tier slot extraction, then sampled candidate replies and a
 *    divergence judgment, so only a slot the samples disagree on is asked;
 *  - the deterministic safety filter (`sanitizeClarificationQuestions`,
 *    credential solicitations dropped, every question attributed to the email);
 *  - attachment-request detection and ranking (inbox/attachmentMatch.ts) over
 *    Files and the mailbox's own attachments (inbox/attachmentSuggest.ts);
 *  - the ask-eagerness dial (inbox/askEagerness.ts);
 *  - answer memory (inbox/clarificationMemory.ts resolveFills), shown as a
 *    pre-picked "last time" answer instead of being dropped silently;
 *  - localization into the owner's interface language.
 *
 * Every model call is fail-soft: a failed stage asks nothing, and the draft is
 * written the way it would be without the check.
 */

import { internal } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { MAX_ASK_QUESTIONS } from '@owlat/shared/answerMode';
import { isAppLocale } from '@owlat/shared/appLocales';
import { resolveLanguageModel } from '../../lib/llmProvider';
import { runLlmObject, runLlmText } from '../../lib/llm/dispatch';
import { recordLlmSpend } from '../../analytics/llmUsage';
import {
	DIVERGENCE_SAMPLES,
	MIN_SAMPLES_FOR_JUDGMENT,
	buildCandidatePrompt,
	buildDivergencePrompt,
	buildSlotPrompt,
	divergenceSchema,
	replySlotsSchema,
	sanitizeClarificationQuestions,
	type ReplySlot,
} from '../../inbox/clarificationSlots';
import {
	isHighStakesSlot,
	resolveEagernessPolicy,
	type EagernessMode,
} from '../../inbox/askEagerness';
import { detectAttachmentRequest } from '../../inbox/attachmentMatch';
import { searchFilesForRequest } from '../../inbox/attachmentSuggest';
import { localizeQuestions } from '../../inbox/clarificationLocalize';
import {
	FILE_QUESTION_ID,
	buildFileQuestion,
	decideFileOutcome,
	fileRequestLabel,
	rankFoundFiles,
	slotAnswerKind,
	type AskQuestion,
	type RankedFile,
} from './composeDraftPolicy';

export interface GapCheckInput {
	/** Untrusted context: the thread (and for a team thread the pipeline briefing). */
	context: string;
	/** The message being answered, for the file-request check. */
	triggerText: string;
	/** Subject of the thread, the file search's fallback query. */
	subject: string;
	counterpartAddress?: string | undefined;
	contactId?: Id<'contacts'> | undefined;
	/** The Postbox mailbox whose own attachments may answer a file request. */
	mailboxId?: Id<'mailboxes'> | undefined;
	eagerness?: EagernessMode | undefined;
	/** The owner's own instruction; a slot it already answers is not asked. */
	instruction?: string | undefined;
	locale: string;
}

export interface GapCheckResult {
	/** Questions in ask order (file first). Some may carry a memory answer. */
	questions: AskQuestion[];
	/** False when the dial is `off`: draft with gaps, never ask. */
	mayAsk: boolean;
	/** One confident file match, to attach without asking. */
	autoAttach?: RankedFile;
	/** The requested file's question id and placeholder label, when one was asked for. */
	fileRequest?: { questionId: string; label: string };
}

/** The attribution line the safety filter gives questions from this sender. */
export function attributionFor(counterpartAddress: string | undefined): string {
	return (
		sanitizeClarificationQuestions(
			[{ slotType: 'attachment', text: 'attribution' }],
			counterpartAddress ?? ''
		)[0]?.attribution ?? ''
	);
}

/**
 * Stage 1 (cheap tier) and stage 2 (sampled replies + divergence, capable
 * tier) of the shared slot check. Returns the slots a good reply needs, that
 * the context does not answer, and that the samples fill differently.
 */
async function findOpenSlots(ctx: ActionCtx, context: string): Promise<ReplySlot[]> {
	try {
		const extracted = await runLlmObject({
			model: await resolveLanguageModel(ctx, 'summarize'),
			schema: replySlotsSchema,
			prompt: buildSlotPrompt(context),
			temperature: 0.2,
		});
		await recordLlmSpend(ctx, 'postbox_answer_slots', extracted.tokenUsage, extracted.modelUsed);
		const candidates = extracted.object.slots.filter(
			(slot) => !slot.answerableFromContext && slot.decisionRelevant
		);
		if (candidates.length === 0) return [];

		const samples: string[] = [];
		for (let i = 0; i < DIVERGENCE_SAMPLES; i++) {
			try {
				const sample = await runLlmText({
					model: await resolveLanguageModel(ctx, 'draft'),
					prompt: buildCandidatePrompt(context),
					temperature: 0.9,
				});
				if (sample.text.trim().length === 0) continue;
				samples.push(sample.text);
				await recordLlmSpend(ctx, 'postbox_answer_diverge', sample.tokenUsage, sample.modelUsed);
			} catch {
				// One failed sample does not end the check; judge on the rest.
			}
		}
		if (samples.length < MIN_SAMPLES_FOR_JUDGMENT) return [];
		const judged = await runLlmObject({
			model: await resolveLanguageModel(ctx, 'draft'),
			schema: divergenceSchema,
			prompt: buildDivergencePrompt(candidates, samples),
			temperature: 0.1,
		});
		await recordLlmSpend(ctx, 'postbox_answer_diverge', judged.tokenUsage, judged.modelUsed);
		const divergent = new Set(judged.object.divergentSlotIndexes);
		return candidates.filter((_, index) => divergent.has(index));
	} catch {
		return [];
	}
}

/** Pre-pick the answers memory already holds for this contact ("last time"). */
async function applyMemory(
	ctx: ActionCtx,
	questions: AskQuestion[],
	scope: { contactId?: Id<'contacts'> | undefined; counterpartAddress?: string | undefined }
): Promise<AskQuestion[]> {
	const askable = questions.filter((q) => q.id !== FILE_QUESTION_ID);
	if (askable.length === 0) return questions;
	try {
		const { fills } = await ctx.runMutation(internal.inbox.clarificationMemory.resolveFills, {
			...(scope.contactId ? { contactId: scope.contactId } : {}),
			...(scope.counterpartAddress ? { fromAddress: scope.counterpartAddress } : {}),
			questions: askable.map((q) => ({ id: q.id, slotType: q.slotType, text: q.text })),
		});
		const at = Date.now();
		const byQuestion = new Map(fills.map((fill) => [fill.questionId, fill.value] as const));
		return questions.map((q) => {
			const value = byQuestion.get(q.id);
			return value === undefined ? q : { ...q, answer: { value, at, source: 'memory' as const } };
		});
	} catch {
		return questions;
	}
}

/** Translate questions into the owner's interface language (fail-soft to English). */
export async function localizeForOwner(
	ctx: ActionCtx,
	questions: AskQuestion[],
	locale: string
): Promise<AskQuestion[]> {
	if (questions.length === 0 || !isAppLocale(locale) || locale === 'en') return questions;
	const localized = await localizeQuestions(
		await resolveLanguageModel(ctx, 'summarize'),
		questions,
		['en', locale]
	);
	if (localized.tokenUsage) {
		await recordLlmSpend(ctx, 'postbox_answer_localize', localized.tokenUsage, localized.modelUsed);
	}
	return localized.questions;
}

/**
 * Run the gap check. The owner's instruction is appended to the context the
 * slot check reads, so "say the invoice goes out Friday" already answers the
 * date and is not asked.
 */
export async function runGapCheck(ctx: ActionCtx, input: GapCheckInput): Promise<GapCheckResult> {
	const policy = resolveEagernessPolicy(input.eagerness, { categoryCautious: false });
	const slotContext = input.instruction
		? `${input.context}\n\n(The recipient's note on what to answer: ${input.instruction})`
		: input.context;
	let slots = await findOpenSlots(ctx, slotContext);

	// A file request: the phrasing in the email, or a slot of type attachment.
	let request = detectAttachmentRequest(input.triggerText);
	if (!request.requested) {
		const attachmentSlot = slots.find((slot) => slot.slotType === 'attachment');
		if (attachmentSlot) {
			request = { requested: true, query: detectAttachmentRequest(attachmentSlot.question).query };
		}
	}
	slots = slots.filter((slot) => slot.slotType !== 'attachment');

	const attribution = attributionFor(input.counterpartAddress);
	const questions: AskQuestion[] = [];
	let autoAttach: RankedFile | undefined;
	let fileRequest: GapCheckResult['fileRequest'];
	if (request.requested) {
		const label = fileRequestLabel(request.query);
		const query = request.query || input.subject;
		const found = await searchFilesForRequest(ctx, {
			query,
			contactId: input.contactId,
			mailboxId: input.mailboxId,
		});
		const outcome = decideFileOutcome(rankFoundFiles(query, found));
		fileRequest = { questionId: FILE_QUESTION_ID, label };
		if (outcome.kind === 'attach') {
			autoAttach = outcome.file;
		} else {
			const question = buildFileQuestion(outcome, label, attribution);
			if (question) questions.push(question);
			else fileRequest = undefined;
		}
	}

	const sanitized = sanitizeClarificationQuestions(
		slots.map((slot) => ({ slotType: slot.slotType, text: slot.question, options: slot.options })),
		input.counterpartAddress ?? ''
	);
	for (const q of sanitized) {
		if (policy.highStakesOnly && !isHighStakesSlot(q.slotType)) continue;
		questions.push({ ...q, answerKind: slotAnswerKind(q.slotType, q.options) });
	}

	// The dial caps what is asked; with the dial off nothing is asked, but the
	// same gaps still become placeholders, capped like a round would be.
	const cap = policy.enabled ? Math.min(policy.maxQuestions, MAX_ASK_QUESTIONS) : MAX_ASK_QUESTIONS;
	const capped = questions.slice(0, cap);
	if (fileRequest && !capped.some((q) => q.id === FILE_QUESTION_ID) && !autoAttach) {
		fileRequest = undefined;
	}
	const remembered = await applyMemory(ctx, capped, input);
	return {
		questions: await localizeForOwner(ctx, remembered, input.locale),
		mayAsk: policy.enabled,
		...(autoAttach ? { autoAttach } : {}),
		...(fileRequest ? { fileRequest } : {}),
	};
}
