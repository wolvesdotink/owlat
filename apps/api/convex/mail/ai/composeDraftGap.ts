'use node';

/**
 * Answer mode gap check: before "Draft with AI" writes a word, find what the
 * reply needs that only the owner knows.
 *
 * Reuses the background clarification machinery rather than forking it:
 *  - the shared clarification service (inbox/clarifyJudge.ts):
 *    cheap-tier slot extraction, then sampled candidate replies (cheap tier
 *    unless the dial is `cautious`) and a divergence judgment, so only a slot
 *    the samples disagree on is asked; or, when the routing policy enforces
 *    D5, one necessity judgment instead of the samples and the judgment;
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
import { meterLlmCall } from '../../analytics/meteredSpend';
import { newRootRequest, type LlmRootContext } from '../../lib/llm/requestMeter';
import { boundedRoot } from '../../lib/llm/actionDeadline';
import {
	emailProvenance,
	itemIdForSlot,
	sanitizeClarificationQuestions,
	splitCandidateSlots,
	type QuestionProvenance,
	type ReplySlot,
	type SlotItem,
} from '../../inbox/clarificationSlots';
import {
	isHighStakesSlot,
	resolveEagernessPolicy,
	type EagernessMode,
} from '../../inbox/askEagerness';
import { detectAttachmentRequest } from '../../inbox/attachmentMatch';
import { searchFilesForRequest } from '../../inbox/attachmentSuggest';
import type { MailboxAttachmentScope } from '../../lib/validators/answerAsk';
import { localizeQuestions } from '../../inbox/clarificationLocalize';
import { answerKindForSlot, applyMemoryFills } from '../../inbox/clarificationAnswers';
import {
	extractReplySlots,
	judgeOpenSlots,
	keptSlots,
	type ClarifySurface,
} from '../../inbox/clarifyJudge';
import type { BundleSubject } from '../../decision/bundleRunner';
import {
	FILE_QUESTION_ID,
	buildFileQuestion,
	decideFileOutcome,
	fileRequestLabel,
	rankFoundFiles,
	type AskQuestion,
	type RankedFile,
} from './composeDraftPolicy';
import { rethrowAdmissionRefusal } from '../../lib/llm/admissionPort';

export interface GapCheckInput {
	/** Untrusted context: the thread (and for a team thread the pipeline briefing). */
	context: string;
	/** The message being answered, for the file-request check. */
	triggerText: string;
	/** Subject of the thread, the file search's fallback query. */
	subject: string;
	counterpartAddress?: string | undefined;
	contactId?: Id<'contacts'> | undefined;
	/** The part of the Postbox mailbox (this thread, the counterpart's mail) the file search reads. */
	mailboxScope?: MailboxAttachmentScope | undefined;
	eagerness?: EagernessMode | undefined;
	/** The owner's own instruction; a slot it already answers is not asked. */
	instruction?: string | undefined;
	locale: string;
	/** The thread's open items: each question names the item it fills (SPEC §6). */
	slotItems?: readonly SlotItem<Id<'threadItems'>>[] | undefined;
	/** The message being answered, the necessity judgment's subject (D5); absent for a fresh draft. */
	decisionSubject?: BundleSubject | undefined;
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

/** The provenance the safety filter gives questions from this sender. */
export function attributionFor(counterpartAddress: string | undefined): QuestionProvenance {
	return emailProvenance(counterpartAddress ?? '');
}

/**
 * Answer mode's surface of the shared clarification service
 * (inbox/clarifyJudge.ts). The background loop runs the check once per inbound
 * message; here it runs on every "Draft with AI" click, so the three samples
 * use the cheap tier the slot extraction uses. Only the `cautious` dial, which
 * asks for the most thorough check, pays for capable-tier samples. The judgment
 * stays capable. The necessity judgment (D5) is asked about the message being
 * answered, under the Postbox `ai` gate, at interactive priority.
 */
function answerClarifySurface(
	ctx: ActionCtx,
	eagerness: EagernessMode | undefined,
	root: LlmRootContext,
	subject: BundleSubject | undefined
): ClarifySurface {
	return {
		features: {
			slots: 'postbox_answer_slots',
			samples: 'postbox_answer_diverge',
			judge: 'postbox_answer_diverge',
		},
		roles: {
			slots: 'summarize',
			samples: eagerness === 'cautious' ? 'draft' : 'summarize',
			judge: 'draft',
		},
		meter: (feature, task, call) =>
			meterLlmCall(ctx, { feature, root, ...(task ? { task } : {}) }, call),
		...(subject ? { subject } : {}),
		root,
		masterGate: 'ai',
		priority: 'interactive',
		// A spend refusal is never a failed sample or judgment: it reaches the user (D1).
		onCallError: rethrowAdmissionRefusal,
	};
}

/**
 * Stage 1 (slot extraction) and stage 2 (which open slots to ask) of the
 * shared check. Returns the slots a good reply needs, that the context does
 * not answer, and that must be asked, plus any file the reply must carry,
 * which skips stage 2 (splitCandidateSlots).
 */
async function findOpenSlots(
	ctx: ActionCtx,
	context: string,
	surface: ClarifySurface,
	items: readonly SlotItem[]
): Promise<ReplySlot[]> {
	// Files owed survive a failed stage 2: they were never judged by it.
	let owed: ReplySlot[] = [];
	try {
		const extracted = await extractReplySlots(ctx, surface, context, items);
		const split = splitCandidateSlots(extracted.slots);
		owed = split.owed;
		const candidates = split.toJudge;
		if (candidates.length === 0) return owed;
		const { judgment } = await judgeOpenSlots(ctx, surface, context, candidates);
		return [...owed, ...keptSlots(judgment, candidates)];
	} catch (error) {
		// A budget refusal is shown to the user (D1); any other fault keeps the owed slots.
		rethrowAdmissionRefusal(error);
		return owed;
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
		return applyMemoryFills(questions, fills, Date.now());
	} catch {
		return questions;
	}
}

/** Translate questions into the owner's interface language (fail-soft to English). */
export async function localizeForOwner(
	ctx: ActionCtx,
	questions: AskQuestion[],
	locale: string,
	root: LlmRootContext = newRootRequest('postbox_action')
): Promise<AskQuestion[]> {
	if (questions.length === 0 || !isAppLocale(locale) || locale === 'en') return questions;
	const model = await resolveLanguageModel(ctx, 'summarize');
	const localized = await meterLlmCall(ctx, { feature: 'postbox_answer_localize', root }, (meter) =>
		localizeQuestions(model, questions, ['en', locale], meter)
	);
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
	const items = input.slotItems ?? [];
	// One "Draft with AI" gap check is one user action (ADR-0073).
	const root = boundedRoot(ctx, newRootRequest('postbox_action'));
	const surface = answerClarifySurface(ctx, input.eagerness, root, input.decisionSubject);
	let slots = await findOpenSlots(ctx, slotContext, surface, items);

	// A file request: the phrasing in the email, or a slot of type attachment.
	let request = detectAttachmentRequest(input.triggerText);
	const attachmentSlot = slots.find((slot) => slot.slotType === 'attachment');
	// The file question keeps the item its slot fills (review F15).
	const fileItemId = attachmentSlot ? itemIdForSlot(attachmentSlot, items) : undefined;
	if (!request.requested) {
		if (attachmentSlot) {
			request = { requested: true, query: detectAttachmentRequest(attachmentSlot.question).query };
		}
	}
	slots = slots.filter((slot) => slot.slotType !== 'attachment');

	const provenance = attributionFor(input.counterpartAddress);
	const questions: AskQuestion[] = [];
	let autoAttach: RankedFile | undefined;
	let fileRequest: GapCheckResult['fileRequest'];
	if (request.requested) {
		const label = fileRequestLabel(request.query);
		const query = request.query || input.subject;
		const found = await searchFilesForRequest(ctx, {
			query,
			contactId: input.contactId,
			mailboxScope: input.mailboxScope,
			root,
		});
		const outcome = decideFileOutcome(rankFoundFiles(query, found));
		fileRequest = { questionId: FILE_QUESTION_ID, label };
		if (outcome.kind === 'attach') {
			autoAttach = outcome.file;
		} else {
			const question = buildFileQuestion(outcome, label, provenance);
			if (question) questions.push(fileItemId ? { ...question, itemId: fileItemId } : question);
			else fileRequest = undefined;
		}
	}

	const sanitized = sanitizeClarificationQuestions(
		slots.map((slot) => ({
			slotType: slot.slotType,
			text: slot.question,
			options: slot.options,
			itemId: itemIdForSlot(slot, items),
		})),
		input.counterpartAddress ?? ''
	);
	for (const q of sanitized) {
		if (policy.highStakesOnly && !isHighStakesSlot(q.slotType)) continue;
		questions.push({ ...q, answerKind: answerKindForSlot(q.slotType, q.options) });
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
		questions: await localizeForOwner(ctx, remembered, input.locale, root),
		mayAsk: policy.enabled,
		...(autoAttach ? { autoAttach } : {}),
		...(fileRequest ? { fileRequest } : {}),
	};
}
