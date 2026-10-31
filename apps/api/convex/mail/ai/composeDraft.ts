'use node';

/**
 * Answer mode "Draft with AI that asks first".
 *
 *   start   gather context → gap check → questions (status `asking`), or, when
 *           nothing is missing or the eagerness dial is off, stream the draft
 *           straight away (`drafting` → `ready`).
 *   answer  record the owner's answers (text, chips, dates, numbers, files),
 *           remember them per contact, attach file answers, and either open
 *           round 2 ("It isn't ready yet" → "When can you send it?") or write
 *           the draft. Without `skip` every question needs an answer;
 *           `skip: true` ("Draft with what I have") drafts at once with
 *           `[[...]]` placeholders for whatever is still open.
 *
 * Gaps only with the owner's say-so: a draft written without `skip` (or with
 * asking turned off) that still has gaps is not shown; its gaps are asked as
 * questions (mail/ai/composeDraftWrite.ts, mail/ai/gapQuestions.ts).
 *
 * A target is a Postbox draft (`mailDraft`) or a team conversation
 * (`teamThread`). For a draft, file answers are attached to the draft itself;
 * for a team thread they are only reported in `attachedFiles` and the web
 * attaches them through the team inbox's reply attachments.
 *
 * The session (mail/ai/composeDraftStore.ts) is what the web subscribes to; the
 * actions return the same view once they finish.
 */

import { v, type Infer } from 'convex/values';
import type { FunctionReturnType } from 'convex/server';
import { authedAction } from '../../lib/authedFunctions';
import { internal } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import { MAX_ASK_ROUNDS } from '@owlat/shared/answerMode';
import { isAppLocale } from '@owlat/shared/appLocales';
import { logError } from '../../lib/runtimeLog';
import { throwInvalidInput } from '../../_utils/errors';
import { answerAskTargetValidator, type AnswerDraftContext } from '../../lib/validators/answerAsk';
import { clarificationFileRefValidator } from '../../lib/validators/clarification';
import {
	attachExistingFile,
	prepareFileAnswer,
	type KeepCopy,
	type PendingUpload,
} from './composeDraftFiles';
import { candidateForLabel } from '../../inbox/clarificationAnswers';
import { throwAskSessionClaimed, toAskSessionView, type AskSessionView } from './composeDraftStore';
import { draftContextOf, loadAnswerContext } from './composeDraftLoad';
import { normalizeTimeZone } from './composeDraftDates';
import { attributionFor, localizeForOwner, runGapCheck } from './composeDraftGap';
import { writeAnswerDraft } from './composeDraftWrite';
import { loadAnswerPlan, loadSlotItems } from './composeDraftPlan';
import { requireFullRead } from './composeDraftFullRead';
import {
	FILE_QUESTION_ID,
	FOLLOW_UP_QUESTION_ID,
	buildFileQuestion,
	buildFollowUpQuestion,
	canonicalAnswerValue,
	followUpFor,
	isNotReadyAnswer,
	leavesQuestionsOpen,
	type AskFileRef,
	type AskQuestion,
} from './composeDraftPolicy';
import { anchorActionDeadline } from '../../lib/llm/actionDeadline';
import { NUDGE_GAP_CHECK, draftInstruction } from './nudgeDraft';

const MAX_INSTRUCTION_CHARS = 2000;
const MAX_ANSWER_CHARS = 2000;

/** Save a second copy of an uploaded answer to Files. Best-effort. */
async function keepCopyInFiles(
	ctx: ActionCtx,
	contactId: Id<'contacts'>,
	file: KeepCopy
): Promise<void> {
	let copyId: Id<'_storage'> | undefined;
	try {
		const blob = await ctx.storage.get(file.storageId);
		if (!blob) return;
		copyId = await ctx.storage.store(blob);
		// checkpoint: a best-effort copy in Files the owner asked to keep, made
		// once the answer landed; a refusal or failure drops only this copy.
		await ctx.runMutation(internal.mail.ai.composeDraftContext.keepAnswerFileCopy, {
			storageId: copyId,
			filename: file.filename,
			// The stored blob carries the upload's type when the metadata lacks one.
			contentType:
				file.contentType === 'application/octet-stream' && blob.type ? blob.type : file.contentType,
			contactId,
		});
	} catch (err) {
		logError('[composeDraft] keeping a copy in Files failed:', err);
		if (copyId) await ctx.storage.delete(copyId);
	}
}

const DRAFT_NOT_STARTED = 'The draft could not be started. Try again.';

/**
 * Put a session this call left `drafting` back where the owner can go on: an
 * answered session to `asking` (its answers kept, so the same answers can be
 * sent again), a started one to `error` (the state a failed draft settles in,
 * from which a new start runs). A session that moved on meanwhile (a draft
 * opened its stream and settled) is left alone. Never throws: the caller
 * rethrows the failure that got it here, a budget refusal included.
 */
async function releaseSession(
	ctx: ActionCtx,
	sessionId: Id<'answerAskSessions'>,
	status: 'asking' | 'error'
): Promise<void> {
	try {
		// checkpoint: hands back this run's `drafting` claim after a failure; what
		// the run committed before it stays, and the owner goes on from there.
		await ctx.runMutation(internal.mail.ai.composeDraftStore.updateSession, {
			sessionId,
			status,
			expectStatus: 'drafting',
			...(status === 'error' ? { errorMessage: DRAFT_NOT_STARTED } : {}),
		});
	} catch (err) {
		logError('[composeDraft] releasing the session failed:', err);
	}
}

/**
 * Write the draft for a session its commit left `drafting` and return the
 * settled view. `writeAnswerDraft` settles the session itself, also when the
 * model fails.
 */
async function draftNow(
	ctx: ActionCtx,
	session: Doc<'answerAskSessions'>,
	context: AnswerDraftContext,
	/** The owner agreed to gaps ("Draft with what I have", or asking off). */
	allowGaps: boolean,
	followUp: ReturnType<typeof followUpFor>
): Promise<AskSessionView> {
	await requireFullRead(ctx, session.target);
	const plan = await loadAnswerPlan(ctx, session);
	await writeAnswerDraft(ctx, {
		sessionId: session._id,
		context: context.context,
		audience: context.audience,
		styleReference: context.styleReference,
		toneInstruction: context.toneInstruction,
		signatureInstruction: context.signatureInstruction,
		voiceSection: context.voiceSection,
		language: context.language,
		contactId: session.contactId,
		questions: session.questions,
		attachedFiles: session.attachedFiles,
		fileLabel: session.fileRequest?.label,
		followUp,
		instruction: session.instruction,
		timeZone: session.timeZone,
		...(plan ? { responsePlan: plan } : {}),
		allowGaps,
		counterpartAddress: session.counterpartAddress,
		locale: session.locale,
	});
	const settled = await ctx.runQuery(internal.mail.ai.composeDraftStore.getOwnSession, {
		sessionId: session._id,
	});
	return toAskSessionView(settled);
}

/**
 * Start "Draft with AI" on a draft or team thread: check for gaps, then ask or
 * draft. Replaces the caller's previous session on the same target.
 */
// authz: the context loaders (mail/ai/composeDraftContext.ts) re-check draft mailbox access or the shared-inbox reader role; the ai flag, spend budget and rate limit run through mail.ai.gate.assertAiAllowed.
export const start = authedAction({
	args: {
		target: answerAskTargetValidator,
		instruction: v.optional(v.string()),
		locale: v.string(),
		// The owner's IANA time zone, for round 2's dates (UTC when absent).
		timeZone: v.optional(v.string()),
		// "Draft a nudge" on a Postbox reply (mail/ai/nudgeDraft.ts).
		purpose: v.optional(v.literal('nudge')),
	},
	handler: async (ctx, args): Promise<AskSessionView> => {
		// One model budget for this action, from its start.
		anchorActionDeadline(ctx);
		// checkpoint: admission before the model calls; the rate-limit token it
		// consumes stays spent when the start fails later, so retries stay bounded.
		await ctx.runMutation(internal.mail.ai.gate.assertAiAllowed, {});
		const note = args.instruction?.trim().slice(0, MAX_INSTRUCTION_CHARS) || undefined;
		const instruction = draftInstruction(args.purpose, note);
		const locale = isAppLocale(args.locale) ? args.locale : 'en';
		const timeZone = normalizeTimeZone(args.timeZone);
		const context = await loadAnswerContext(ctx, args.target, args.purpose);
		// Read on arrival: no model call on a thread not fully read (Sol r2 F1).
		await requireFullRead(ctx, args.target);
		const gap = args.purpose
			? NUDGE_GAP_CHECK
			: await runGapCheck(ctx, {
					context: context.context,
					triggerText: context.triggerText,
					subject: context.subject,
					counterpartAddress: context.counterpartAddress,
					contactId: context.contactId,
					mailboxScope: context.mailboxScope,
					eagerness: context.eagerness,
					instruction,
					locale,
					slotItems: await loadSlotItems(ctx, args.target),
					decisionSubject: context.decisionSubject,
				});

		let questions = gap.questions;

		// One confident match: attach it without asking. If that fails (the file
		// went away, the draft filled up), ask for the file instead.
		const attachedFiles: AskFileRef[] = [];
		if (gap.autoAttach) {
			try {
				attachedFiles.push(
					await attachExistingFile(ctx, args.target, {
						source: gap.autoAttach.source,
						id: gap.autoAttach.id,
					})
				);
			} catch (err) {
				logError('[composeDraft] attaching the matched file failed:', err);
				const fallback = buildFileQuestion(
					{ kind: 'missing', near: [gap.autoAttach] },
					gap.fileRequest?.label ?? 'the requested file',
					attributionFor(context.counterpartAddress)
				);
				if (fallback)
					questions = [...(await localizeForOwner(ctx, [fallback], locale)), ...questions];
			}
		}

		const isAsking = gap.mayAsk && questions.some((q) => !q.answer);
		const draftContext = draftContextOf(context);
		const followUp = isAsking
			? undefined
			: followUpFor(questions, gap.fileRequest?.label, Date.now(), timeZone);
		// One commit: the session, and the follow-up a session drafting now promises.
		const session = await ctx.runMutation(internal.mail.ai.composeDraftCommit.commitStart, {
			target: args.target,
			...(instruction ? { instruction } : {}),
			locale,
			status: isAsking ? 'asking' : 'drafting',
			questions,
			attachedFiles,
			...(context.contactId ? { contactId: context.contactId } : {}),
			...(context.counterpartAddress ? { counterpartAddress: context.counterpartAddress } : {}),
			...(gap.fileRequest ? { fileRequest: gap.fileRequest } : {}),
			...(draftContext ? { draftContext } : {}),
			...(timeZone ? { timeZone } : {}),
			...(followUp?.at !== undefined ? { followUpAt: followUp.at } : {}),
		});
		if (isAsking) return toAskSessionView(session);
		try {
			// Asking turned off is the owner's standing "draft with what I have".
			return await draftNow(ctx, session, context, !gap.mayAsk, followUp);
		} catch (err) {
			// Before its stream settles the session would stay busy for good.
			await releaseSession(ctx, session._id, 'error');
			throw err;
		}
	},
});

const givenAnswerValidator = v.object({
	questionId: v.string(),
	value: v.optional(v.string()),
	file: v.optional(clarificationFileRefValidator),
	keepCopy: v.optional(v.boolean()),
});

/**
 * Fold the owner's answers into the session's questions, preparing file
 * answers on the way (their uploads and Files copies wait for the commit), and
 * open round 2 when "It isn't ready yet" asks for it.
 */
async function applyAnswers(
	ctx: ActionCtx,
	session: Doc<'answerAskSessions'>,
	answers: ReadonlyArray<Infer<typeof givenAnswerValidator>>,
	skip: boolean,
	timeZone: string | undefined
) {
	const now = Date.now();
	const questions: AskQuestion[] = session.questions.map((q) => ({ ...q }));
	let attachedFiles = [...session.attachedFiles];
	const answered: string[] = [];
	const uploads: PendingUpload[] = [];
	const keeps: KeepCopy[] = [];
	const seen = new Set<string>();
	for (const given of answers) {
		const question = questions.find((q) => q.id === given.questionId);
		if (!question) continue;
		// A client that sends a candidate's chip label instead of a file
		// reference still picks that candidate.
		const picked =
			!given.file && given.value && question.answerKind === 'file'
				? candidateForLabel(question.fileCandidates, given.value)
				: undefined;
		const givenFile =
			given.file ??
			(picked ? { source: picked.source, id: picked.id, filename: picked.filename } : undefined);
		if (givenFile) {
			if (question.answerKind !== 'file') throwInvalidInput('Only a file question takes a file');
			const prepared = await prepareFileAnswer(
				ctx,
				session,
				givenFile,
				given.keepCopy !== false,
				seen
			);
			if (prepared.upload) uploads.push(prepared.upload);
			if (prepared.keep) keeps.push(prepared.keep);
			const { ref } = prepared;
			question.answer = { value: ref.filename, at: now, source: 'user', file: ref };
			attachedFiles = [
				...attachedFiles.filter((f) => !(f.source === ref.source && f.id === ref.id)),
				ref,
			];
		} else {
			const value = given.value?.trim().slice(0, MAX_ANSWER_CHARS);
			if (!value) continue;
			question.answer = { value: canonicalAnswerValue(question, value), at: now, source: 'user' };
		}
		answered.push(question.id);
	}

	const file = questions.find((q) => q.id === FILE_QUESTION_ID);
	const opensRoundTwo =
		!skip &&
		session.round < MAX_ASK_ROUNDS &&
		!!file &&
		answered.includes(file.id) &&
		isNotReadyAnswer(file, file.answer?.value) &&
		!questions.some((q) => q.id === FOLLOW_UP_QUESTION_ID);
	if (opensRoundTwo) {
		const label = session.fileRequest?.label ?? 'the requested file';
		const [followUpQuestion] = await localizeForOwner(
			ctx,
			[buildFollowUpQuestion(label, file, now, timeZone)],
			session.locale
		);
		questions.push(followUpQuestion!);
	}
	const followUp = opensRoundTwo
		? undefined
		: followUpFor(questions, session.fileRequest?.label, now, timeZone);
	return { questions, attachedFiles, answered, opensRoundTwo, uploads, keeps, followUp };
}

/**
 * Answer the open questions (or skip them) and continue: round 2 when an
 * answer opened a new gap, otherwise the draft.
 */
// authz: composeDraftStore.getOwnSession requires the caller to own the session and still reach its target; file answers re-check access in composeDraftContext / attachExisting.
export const answer = authedAction({
	args: {
		sessionId: v.id('answerAskSessions'),
		answers: v.array(givenAnswerValidator),
		skip: v.optional(v.boolean()),
		// The owner's IANA time zone; replaces the one `start` stored.
		timeZone: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<AskSessionView> => {
		// One model budget for this action, from its start.
		anchorActionDeadline(ctx);
		// checkpoint: admission before the model calls; the rate-limit token it
		// consumes stays spent when the answer fails later, so retries stay bounded.
		await ctx.runMutation(internal.mail.ai.gate.assertAiAllowed, {});
		const session = await ctx.runQuery(internal.mail.ai.composeDraftStore.getOwnSession, {
			sessionId: args.sessionId,
		});
		if (session.status !== 'asking') throwAskSessionClaimed();
		if (args.skip !== true && leavesQuestionsOpen(session.questions, args.answers)) {
			throwInvalidInput('Answer every question, or draft with what you have');
		}
		// checkpoint: the claim, taken before anything is attached. A second call
		// racing this one (a double tap, a retry after a slow first call) is
		// refused here instead of attaching the same file again and opening a
		// second stream under the first; a failure below hands it back.
		await ctx.runMutation(internal.mail.ai.composeDraftStore.updateSession, {
			sessionId: session._id,
			status: 'drafting',
			expectStatus: 'asking',
		});
		const timeZone = normalizeTimeZone(args.timeZone) ?? session.timeZone;
		let applied: Awaited<ReturnType<typeof applyAnswers>>;
		let committed: FunctionReturnType<typeof internal.mail.ai.composeDraftCommit.commitAnswers>;
		try {
			applied = await applyAnswers(ctx, session, args.answers, args.skip === true, timeZone);
			// One commit: the uploads, the answers (or round 2), the remembered
			// answers and the follow-up, under the claim taken above.
			committed = await ctx.runMutation(internal.mail.ai.composeDraftCommit.commitAnswers, {
				sessionId: session._id,
				status: applied.opensRoundTwo ? 'asking' : 'drafting',
				round: applied.opensRoundTwo ? session.round + 1 : session.round,
				questions: applied.questions,
				attachedFiles: applied.attachedFiles,
				...(timeZone ? { timeZone } : {}),
				uploads: applied.uploads,
				answeredIds: applied.answered,
				...(applied.followUp?.at !== undefined ? { followUpAt: applied.followUp.at } : {}),
			});
		} catch (err) {
			// Hand the questions back, with the answers already stored, so the
			// owner can fix an answer or send them again: a failed file answer, a
			// briefing refused for budget.
			await releaseSession(ctx, session._id, 'asking');
			throw err;
		}
		// Taken from under this run: nothing was written, and the claim is not ours to hand back.
		if (committed.outcome === 'claimed') throwAskSessionClaimed();
		if (session.contactId) {
			for (const keep of applied.keeps) await keepCopyInFiles(ctx, session.contactId, keep);
		}
		const updated = committed.session;
		if (applied.opensRoundTwo) return toAskSessionView(updated);
		try {
			// The context `start` built; rebuilt only for a session that has none.
			const context = updated.draftContext ?? (await loadAnswerContext(ctx, session.target));
			return await draftNow(ctx, updated, context, args.skip === true, applied.followUp);
		} catch (err) {
			// A draft that never opened its stream: the questions come back, answered.
			await releaseSession(ctx, session._id, 'asking');
			throw err;
		}
	},
});
