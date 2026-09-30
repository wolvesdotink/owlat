'use node';

/**
 * Answer mode "Draft with AI that asks first" (plan §05 and §06).
 *
 *   start   gather context → gap check → questions (status `asking`), or, when
 *           nothing is missing or the eagerness dial is off, stream the draft
 *           straight away (`drafting` → `ready`).
 *   answer  record the owner's answers (text, chips, dates, numbers, files),
 *           remember them per contact, attach file answers, and either open
 *           round 2 ("It isn't ready yet" → "When can you send it?") or write
 *           the draft. `skip: true` drafts at once with `[[...]]` placeholders
 *           for whatever is still open.
 *
 * A target is a Postbox draft (`mailDraft`) or a team conversation
 * (`teamThread`). For a draft, file answers are attached to the draft itself;
 * for a team thread they are only reported in `attachedFiles` and the web
 * attaches them through the team inbox's reply attachments.
 *
 * The session (mail/ai/composeDraftStore.ts) is what the web subscribes to; the
 * actions return the same view once they finish.
 */

import { v } from 'convex/values';
import { authedAction } from '../../lib/authedFunctions';
import { api, internal } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import { MAX_ASK_ROUNDS } from '@owlat/shared/answerMode';
import { isAppLocale } from '@owlat/shared/appLocales';
import { logError } from '../../lib/runtimeLog';
import { throwInvalidInput, throwInvalidState } from '../../_utils/errors';
import { answerAskTargetValidator, type AnswerAskTarget } from '../../lib/validators/answerAsk';
import { clarificationFileRefValidator } from '../../lib/validators/clarification';
import { assembleInboundBriefing } from '../../agent/steps/context_retrieval';
import type { EagernessMode } from '../../inbox/askEagerness';
import { copyExistingIntoDraft } from '../attachExisting';
import { candidateForLabel } from '../../inbox/clarificationAnswers';
import { formatVoiceSection, loadVoiceGuidance } from './voiceGuidance';
import { toAskSessionView, type AskSessionView } from './composeDraftStore';
import { attributionFor, localizeForOwner, runGapCheck } from './composeDraftGap';
import { writeAnswerDraft } from './composeDraftWrite';
import {
	FILE_QUESTION_ID,
	FOLLOW_UP_QUESTION_ID,
	buildFileQuestion,
	buildFollowUpQuestion,
	canonicalAnswerValue,
	formatGapFor,
	isNotReadyAnswer,
	resolveFollowUpAt,
	type AskFileRef,
	type AskQuestion,
} from './composeDraftPolicy';

const MAX_INSTRUCTION_CHARS = 2000;
const MAX_ANSWER_CHARS = 2000;

/** Everything the gap check and the drafter need about a target. */
interface AnswerContext {
	context: string;
	triggerText: string;
	subject: string;
	counterpartAddress?: string | undefined;
	contactId?: Id<'contacts'> | undefined;
	language?: string | undefined;
	mailboxId?: Id<'mailboxes'> | undefined;
	eagerness?: EagernessMode | undefined;
	audience: string;
	styleReference: string;
	toneInstruction: string;
	signatureInstruction: string;
	voiceSection: string;
}

const PERSONAL_TONE =
	'\n\nTone: match the owner’s natural, personal style — warm and direct, not corporate.';

/** Open commitments to the contact, one line each, or '' (fail-soft). */
async function commitmentSection(ctx: ActionCtx, contactId: Id<'contacts'>): Promise<string> {
	try {
		const open = await ctx.runQuery(internal.knowledge.graph.getOpenCommitmentsByContact, {
			contactId,
			limit: 5,
		});
		if (open.length === 0) return '';
		return `[OPEN COMMITMENTS — still owed to this contact]\n${open
			.map((c) => `- ${c.title}: ${c.content.slice(0, 300)}`)
			.join('\n')}\n\n`;
	} catch {
		return '';
	}
}

/** Load (access-checked) and assemble the context for a target. */
async function loadAnswerContext(ctx: ActionCtx, target: AnswerAskTarget): Promise<AnswerContext> {
	if (target.kind === 'mailDraft') {
		const loaded = await ctx.runQuery(internal.mail.ai.composeDraftContext.loadMailDraftContext, {
			draftId: target.draftId,
		});
		const contact = loaded.contact;
		const contactLine = contact
			? `[CONTACT] ${loaded.counterpartAddress ?? ''}${contact.name ? ` | Name: ${contact.name}` : ''}${contact.language ? ` | Language: ${contact.language}` : ''}\n\n`
			: '';
		const commitments = contact ? await commitmentSection(ctx, contact.contactId) : '';
		return {
			context: `${contactLine}${commitments}${loaded.transcript}`,
			triggerText: loaded.triggerText,
			subject: loaded.subject,
			counterpartAddress: loaded.counterpartAddress,
			contactId: contact?.contactId,
			language: contact?.language,
			mailboxId: loaded.mailboxId,
			eagerness: loaded.eagerness,
			audience: `the mailbox owner (${loaded.ownerAddress}), answering the last message in the thread, which the other party sent`,
			styleReference: "the owner's",
			toneInstruction: PERSONAL_TONE,
			signatureInstruction: '',
			// The mailbox was access-checked by the loader above.
			voiceSection: formatVoiceSection(
				await loadVoiceGuidance(ctx, { mailboxId: loaded.mailboxId, requireAccess: false })
			),
		};
	}
	const loaded = await ctx.runQuery(internal.mail.ai.composeDraftContext.loadTeamThreadContext, {
		threadId: target.threadId,
	});
	// The pipeline's own briefing (contact, commitments, knowledge, files,
	// history, the quarantined current message), without re-recording it.
	let context = loaded.triggerText;
	try {
		context = (await assembleInboundBriefing(ctx, loaded.inboundMessageId)).context;
	} catch (err) {
		logError('[composeDraft] team briefing failed, drafting from the message:', err);
	}
	const agentConfig = await ctx.runQuery(internal.agent.agentPipeline.getAgentConfig, {});
	return {
		context,
		triggerText: loaded.triggerText,
		subject: loaded.subject,
		counterpartAddress: loaded.counterpartAddress,
		contactId: loaded.contact?.contactId,
		language: loaded.contact?.language,
		eagerness: loaded.eagerness,
		audience: 'an organization',
		styleReference: "the organization's",
		toneInstruction: agentConfig?.toneDescription
			? `\n\nTone guidance: ${agentConfig.toneDescription}`
			: '\n\nTone: Professional and helpful. Use a friendly but concise style.',
		signatureInstruction: agentConfig?.signatureTemplate
			? `\n\nEnd the email with this signature:\n${agentConfig.signatureTemplate}`
			: '',
		voiceSection: '',
	};
}

/** Where a file answer goes: the target, and the contact Files copies are linked to. */
interface FileOwner {
	target: AnswerAskTarget;
	contactId?: Id<'contacts'> | undefined;
}

/**
 * Attach a file answer. A draft gets the file itself (a fresh upload is
 * consumed by `drafts.addAttachment`, an existing file is copied in); a team
 * thread only gets the reference checked and reported. An upload is also kept
 * in Files for the contact unless the owner opted out (plan decision 5), when
 * the caller may add to Files (lib/answerFileToFiles.ts).
 */
async function attachFileAnswer(
	ctx: ActionCtx,
	session: FileOwner,
	file: AskFileRef,
	keepCopy: boolean
): Promise<AskFileRef> {
	const filename =
		file.filename
			.replace(/[\r\n\t]/g, ' ')
			.trim()
			.slice(0, 255) || 'attachment';
	if (file.source === 'upload') {
		const storageId = file.id as Id<'_storage'>;
		const info = await ctx.runQuery(internal.mail.ai.composeDraftContext.ownUploadInfo, {
			storageId,
		});
		if (keepCopy && session.contactId && info.canSaveToFiles) {
			await keepCopyInFiles(ctx, session, {
				storageId,
				filename,
				contentType: info.contentType,
			});
		}
		if (session.target.kind === 'mailDraft') {
			await ctx.runMutation(api.mail.drafts.addAttachment, {
				draftId: session.target.draftId,
				storageId,
				filename,
				contentType: info.contentType,
				size: info.size,
			});
		}
		return { source: 'upload', id: storageId, filename };
	}
	if (session.target.kind === 'mailDraft') {
		const copied = await copyExistingIntoDraft(ctx, {
			draftId: session.target.draftId,
			source: file.source,
			id: file.id,
		});
		return { source: file.source, id: file.id, filename: copied.filename };
	}
	const readable = await ctx.runQuery(internal.mail.attachExisting.resolveReadableFile, {
		source: file.source,
		id: file.id,
	});
	return { source: file.source, id: file.id, filename: readable.filename };
}

/** Save a second copy of an uploaded answer to Files. Best-effort. */
async function keepCopyInFiles(
	ctx: ActionCtx,
	session: FileOwner,
	file: { storageId: Id<'_storage'>; filename: string; contentType: string }
): Promise<void> {
	if (!session.contactId) return;
	let copyId: Id<'_storage'> | undefined;
	try {
		const blob = await ctx.storage.get(file.storageId);
		if (!blob) return;
		copyId = await ctx.storage.store(blob);
		await ctx.runMutation(internal.mail.ai.composeDraftContext.keepAnswerFileCopy, {
			storageId: copyId,
			filename: file.filename,
			// The stored blob carries the upload's type when the metadata lacks one.
			contentType:
				file.contentType === 'application/octet-stream' && blob.type ? blob.type : file.contentType,
			contactId: session.contactId,
		});
	} catch (err) {
		logError('[composeDraft] keeping a copy in Files failed:', err);
		if (copyId) await ctx.storage.delete(copyId);
	}
}

/** What the draft promises when the requested file is not ready yet. */
function followUpFor(
	questions: readonly AskQuestion[],
	fileLabel: string | undefined,
	now: number
): { value: string; at?: number } | undefined {
	const file = questions.find((q) => q.id === FILE_QUESTION_ID);
	if (!file || !isNotReadyAnswer(file, file.answer?.value)) return undefined;
	const date = questions.find((q) => q.id === FOLLOW_UP_QUESTION_ID);
	if (!date) return { value: 'as soon as it is ready' };
	if (!date.answer) return { value: formatGapFor(date, fileLabel) };
	const at = resolveFollowUpAt(date.answer.value, now);
	return { value: date.answer.value, ...(at !== undefined ? { at } : {}) };
}

/** Write the draft for a session and return the settled view. */
async function draftNow(
	ctx: ActionCtx,
	session: Doc<'answerAskSessions'>,
	context: AnswerContext
): Promise<AskSessionView> {
	const now = Date.now();
	const followUp = followUpFor(session.questions, session.fileRequest?.label, now);
	if (followUp?.at !== undefined) {
		await ctx.runMutation(internal.mail.ai.composeDraftStore.updateSession, {
			sessionId: session._id,
			status: 'drafting',
			followUpAt: followUp.at,
		});
		await ctx.runMutation(internal.mail.ai.composeDraftStore.setDraftFollowUp, {
			sessionId: session._id,
			remindAt: followUp.at,
		});
	}
	await writeAnswerDraft(ctx, {
		sessionId: session._id,
		context: context.context,
		audience: context.audience,
		styleReference: context.styleReference,
		toneInstruction: context.toneInstruction,
		signatureInstruction: context.signatureInstruction,
		voiceSection: context.voiceSection,
		language: context.language,
		contactId: context.contactId,
		questions: session.questions,
		attachedFiles: session.attachedFiles,
		fileLabel: session.fileRequest?.label,
		followUp,
		instruction: session.instruction,
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
	},
	handler: async (ctx, args): Promise<AskSessionView> => {
		await ctx.runMutation(internal.mail.ai.gate.assertAiAllowed, {});
		const instruction = args.instruction?.trim().slice(0, MAX_INSTRUCTION_CHARS) || undefined;
		const locale = isAppLocale(args.locale) ? args.locale : 'en';
		const context = await loadAnswerContext(ctx, args.target);
		const gap = await runGapCheck(ctx, {
			context: context.context,
			triggerText: context.triggerText,
			subject: context.subject,
			counterpartAddress: context.counterpartAddress,
			contactId: context.contactId,
			mailboxId: context.mailboxId,
			eagerness: context.eagerness,
			instruction,
			locale,
		});

		let questions = gap.questions;

		// One confident match: attach it without asking. If that fails (the file
		// went away, the draft filled up), ask for the file instead.
		const attachedFiles: AskFileRef[] = [];
		if (gap.autoAttach) {
			try {
				attachedFiles.push(
					await attachFileAnswer(
						ctx,
						{ target: args.target, contactId: context.contactId },
						{
							source: gap.autoAttach.source,
							id: gap.autoAttach.id,
							filename: gap.autoAttach.filename,
						},
						false
					)
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
		const session = await ctx.runMutation(internal.mail.ai.composeDraftStore.replaceSession, {
			target: args.target,
			...(instruction ? { instruction } : {}),
			locale,
			status: isAsking ? 'asking' : 'drafting',
			questions,
			attachedFiles,
			...(context.contactId ? { contactId: context.contactId } : {}),
			...(context.counterpartAddress ? { counterpartAddress: context.counterpartAddress } : {}),
			...(gap.fileRequest ? { fileRequest: gap.fileRequest } : {}),
		});
		if (isAsking) return toAskSessionView(session);
		return await draftNow(ctx, session, context);
	},
});

/**
 * Answer the open questions (or skip them) and continue: round 2 when an
 * answer opened a new gap, otherwise the draft.
 */
// authz: composeDraftStore.getOwnSession requires the caller to own the session and still reach its target; file answers re-check access in composeDraftContext / attachExisting.
export const answer = authedAction({
	args: {
		sessionId: v.id('answerAskSessions'),
		answers: v.array(
			v.object({
				questionId: v.string(),
				value: v.optional(v.string()),
				file: v.optional(clarificationFileRefValidator),
				keepCopy: v.optional(v.boolean()),
			})
		),
		skip: v.optional(v.boolean()),
	},
	handler: async (ctx, args): Promise<AskSessionView> => {
		await ctx.runMutation(internal.mail.ai.gate.assertAiAllowed, {});
		const session = await ctx.runQuery(internal.mail.ai.composeDraftStore.getOwnSession, {
			sessionId: args.sessionId,
		});
		if (session.status !== 'asking') throwInvalidState('These questions were already answered');

		const now = Date.now();
		const questions: AskQuestion[] = session.questions.map((q) => ({ ...q }));
		let attachedFiles = [...session.attachedFiles];
		const answered: string[] = [];
		for (const given of args.answers) {
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
				const ref = await attachFileAnswer(ctx, session, givenFile, given.keepCopy !== false);
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
			!args.skip &&
			session.round < MAX_ASK_ROUNDS &&
			!!file &&
			answered.includes(file.id) &&
			isNotReadyAnswer(file, file.answer?.value) &&
			!questions.some((q) => q.id === FOLLOW_UP_QUESTION_ID);
		if (opensRoundTwo) {
			const [followUpQuestion] = await localizeForOwner(
				ctx,
				[
					buildFollowUpQuestion(
						session.fileRequest?.label ?? 'the requested file',
						file.attribution,
						now
					),
				],
				session.locale
			);
			questions.push(followUpQuestion!);
		}

		const updated = await ctx.runMutation(internal.mail.ai.composeDraftStore.updateSession, {
			sessionId: session._id,
			status: opensRoundTwo ? 'asking' : 'drafting',
			round: opensRoundTwo ? session.round + 1 : session.round,
			questions,
			attachedFiles,
		});
		if (answered.length > 0) {
			await ctx.runMutation(internal.mail.ai.composeDraftStore.captureSessionAnswers, {
				sessionId: session._id,
				questionIds: answered,
			});
		}
		if (opensRoundTwo) return toAskSessionView(updated);
		return await draftNow(ctx, updated, await loadAnswerContext(ctx, session.target));
	},
});
