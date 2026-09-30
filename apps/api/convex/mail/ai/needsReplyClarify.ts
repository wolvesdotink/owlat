/**
 * Postbox clarification loop — the owner answers a "Needs your input" Reply
 * Queue card and Owlat drafts a starter reply from the pinned answers.
 *
 * Split out of `mail/needsReply.ts` (the Reply Queue foundation) to keep that
 * file under the ~500 LOC domain-file gate: the detection/queue/sweep surface
 * lives there; the answer→draft surface lives here. The persisted shape
 * (`needsReply.clarification`) and the base context helper
 * (`NEEDS_REPLY_CONTEXT_MESSAGES`) are still owned by `needsReply.ts` and
 * imported here — this module never redefines them.
 *
 * Flow: `answerClarification` folds each answer onto the thread and schedules
 * `needsReplyClassify.draftWithAnswers`, which reads `getClarificationContext`
 * (bounded transcript + confirmed answers) and writes the draft back via
 * `persistClarificationDraft`. Fail-soft throughout: if the draft never lands
 * the answer is still recorded and the plain "Draft reply" button keeps working.
 */

import { v } from 'convex/values';
import { normalizeEmail } from '@owlat/shared';
import { internalQuery } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import { postboxMutation } from '../_helpers';
import { internal } from '../../_generated/api';
import { getOrThrow, throwForbidden, throwInvalidInput, throwNotFound } from '../../_utils/errors';
import { requireMailboxAccess } from '../permissions';
import { NEEDS_REPLY_CONTEXT_MESSAGES } from '../needsReply';
import { captureStandingAnswers } from '../../inbox/clarificationMemory';
import { buildFileAnswerNotes, isFileQuestion } from '../../inbox/clarificationAnswers';
import {
	resolveClarificationFile,
	type ClarificationFileRef,
} from '../../inbox/clarificationFileAnswer';
import { findContactByIdentifier } from '../../contacts/resolution';
import { canSaveAnswerToFiles } from '../../lib/answerFileToFiles';
import { clarificationFileRefValidator } from '../../lib/validators/clarification';
import { buildThreadTranscript, CLARIFY_DRAFT } from './transcript';
import { withStoredInlineBodies } from '../../lib/messageBodyStore';
import type { Id } from '../../_generated/dataModel';

/**
 * Answer the clarification questions on a Reply Queue thread and kick off the
 * draft.
 *
 * Backs the "Needs your input" card: the owner types / taps the scoped answers
 * inline and the card flips to "Draft ready". This folds each answer onto
 * `needsReply.clarification`, stamps `answeredAt`, and schedules
 * `draftWithAnswers` off the scheduler (so a slow model never blocks the
 * mutation) which reuses the suggestReplies infra + voice profile + the pinned
 * answers to produce the starter reply. Fail-soft: if the draft never lands the
 * answer is still recorded and the plain "Draft reply" button keeps working.
 */
// authz: thread → mailbox access via requireMailboxAccess; org membership via
// authedMutation. File answers re-check the file (resolveClarificationFile).
export const answerClarification = postboxMutation({
	args: {
		threadId: v.id('mailThreads'),
		answers: v.array(
			v.object({
				questionId: v.string(),
				// Required unless `file` is given (then it defaults to the filename).
				value: v.optional(v.string()),
				// 'memory' when the owner kept a remembered ("last time") answer.
				source: v.optional(v.union(v.literal('user'), v.literal('memory'))),
				file: v.optional(clarificationFileRefValidator),
				// Uploads only: false keeps the upload out of Files; the browser's
				// MIME type for the upload.
				keepCopy: v.optional(v.boolean()),
				mimeType: v.optional(v.string()),
			})
		),
	},
	handler: async (ctx, args, session) => {
		const thread = await getOrThrow(ctx, args.threadId, 'Thread');
		const owned = await requireMailboxAccess(ctx, thread.mailboxId);
		if (!owned.ok) throwForbidden('Thread not accessible');

		const flag = thread.needsReply;
		const clarification = flag?.clarification;
		if (!flag || !clarification) throwNotFound('Clarification');

		const now = Date.now();
		const answerByQuestion = new Map(args.answers.map((a) => [a.questionId, a] as const));
		// Guard: at least one submitted answer must map to a real question before
		// we stamp the clarification answered + schedule the draft. A payload that
		// matches nothing would otherwise mark it answered with zero recorded
		// answers, so draftWithAnswers produces no draft and the card strands in
		// 'drafting' forever. Reject instead of silently answering nothing. A card
		// whose every question memory pre-picked may be confirmed as it stands.
		let matched = 0;
		let prePicked = 0;
		for (const q of clarification.questions) {
			if (answerByQuestion.has(q.id)) matched += 1;
			else if (q.answer) prePicked += 1;
		}
		if (matched === 0 && prePicked === 0) throwInvalidInput('No answer matches an open question');

		const senderMessage = await ctx.db.get(flag.messageId);
		const fromAddress = senderMessage?.fromAddress;
		// Uploaded answers are kept in Files for the sender's contact, by the
		// shared rules (lib/answerFileToFiles.ts: admins only, like the Files page).
		let senderContactId: Id<'contacts'> | undefined;
		if (fromAddress && canSaveAnswerToFiles(session)) {
			const identifier = normalizeEmail(fromAddress);
			const found = identifier ? await findContactByIdentifier(ctx, 'email', identifier) : null;
			senderContactId = found?.contact._id;
		}

		const questions = [];
		for (const q of clarification.questions) {
			const provided = answerByQuestion.get(q.id);
			if (!provided) {
				questions.push(q);
				continue;
			}
			const fileRef: ClarificationFileRef | undefined = provided.file;
			if (fileRef && !isFileQuestion(q)) throwInvalidInput('This question does not take a file');
			const resolved = fileRef
				? await resolveClarificationFile(ctx, session, fileRef, {
						keepCopy: provided.keepCopy,
						mimeType: provided.mimeType,
						contactId: senderContactId,
					})
				: undefined;
			const value = provided.value ?? resolved?.ref.filename;
			if (value === undefined) throwInvalidInput('An answer needs a value or a file');
			questions.push({
				...q,
				answer: {
					value: value.slice(0, 2000),
					at: now,
					source: provided.source ?? ('user' as const),
					...(resolved ? { file: resolved.ref } : {}),
				},
			});
		}

		await ctx.db.patch(args.threadId, {
			needsReply: {
				...flag,
				clarification: { ...clarification, questions, answeredAt: now, isNeeded: false },
			},
			updatedAt: now,
		});

		// ANSWER-MEMORY: promote the owner's answers to durable standing facts,
		// scoped to the thread's sender contact, so a later matching thread
		// pre-picks them. Remembered answers the owner merely kept are not
		// re-captured, and neither are file answers (true for this request only).
		// Fail-soft: a memory-write failure never blocks the starter draft below.
		try {
			if (fromAddress) {
				const capture = [] as { slotType: string; questionText: string; value: string }[];
				for (const q of questions) {
					const provided = answerByQuestion.get(q.id);
					if (!provided || !q.answer) continue;
					if ((provided.source ?? 'user') !== 'user') continue;
					if (isFileQuestion(q)) continue;
					capture.push({ slotType: q.slotType, questionText: q.text, value: q.answer.value });
				}
				if (capture.length > 0) {
					await captureStandingAnswers(ctx, {
						fromAddress,
						source: 'reply_queue',
						answers: capture,
					});
				}
			}
		} catch {
			// Memory is best-effort — never block the draft schedule below.
		}

		// Off the scheduler — the answer is already committed above.
		await ctx.scheduler.runAfter(0, internal.mail.ai.needsReplyClassify.draftWithAnswers, {
			threadId: args.threadId,
		});

		return { success: true };
	},
});

/**
 * Bounded context for the `draftWithAnswers` action: the mailbox id, a short
 * transcript of the newest messages, the owner's confirmed answers (typed and
 * remembered) folded into `question: answer` lines, a note for each file they
 * attached, and the sender's contact (the knowledge recall scope). Null when
 * the clarification is gone / stale.
 */
export const getClarificationContext = internalQuery({
	args: { threadId: v.id('mailThreads') },
	handler: async (ctx, args) => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread) return null;
		const flag = thread.needsReply;
		const clarification = flag?.clarification;
		if (!flag || !clarification || clarification.answeredAt === undefined) return null;
		const mailbox = await ctx.db.get(thread.mailboxId);
		if (!mailbox || mailbox.status !== 'active') return null;

		// Bounded index read — take the newest N by arrival, then re-sort
		// ascending for a natural transcript. Never collect the whole thread.
		const newestFirst = await ctx.db
			.query('mailMessages')
			.withIndex('by_thread', (q) => q.eq('threadId', args.threadId))
			.order('desc')
			.take(NEEDS_REPLY_CONTEXT_MESSAGES);
		const newest = newestFirst.sort((a, b) => a.receivedAt - b.receivedAt);
		// Labelled by side with the flagged message last and marked: this
		// transcript drafts the owner's reply, exactly like draft-on-arrival.
		const transcript = await buildThreadTranscript(await withStoredInlineBodies(ctx.db, newest), {
			...CLARIFY_DRAFT,
			ownerAddress: mailbox.address,
			triggerId: flag.messageId,
		});

		const answers = [];
		// Slot kinds of the ANSWERED questions — carried through so the draft path
		// can score the predicted value of the ask (see inbox/askEagerness.ts)
		// without re-reading the thread.
		const answeredSlotTypes: string[] = [];
		for (const q of clarification.questions) {
			if (q.answer) {
				answers.push({ question: q.text, answer: q.answer.value });
				answeredSlotTypes.push(q.slotType);
			}
		}

		// The sender's contact scopes the draft's knowledge recall; no contact →
		// org-general knowledge only. Same identity index the answer memory uses.
		const trigger =
			newest.find((m) => m._id === flag.messageId) ?? (await ctx.db.get(flag.messageId));
		const identifier = trigger?.fromAddress ? normalizeEmail(trigger.fromAddress) : '';
		const identity = identifier
			? await ctx.db
					.query('contactIdentities')
					.withIndex('by_identifier', (q) => q.eq('channel', 'email').eq('identifier', identifier))
					.first()
			: null;

		return {
			mailboxId: thread.mailboxId,
			latestMessageId: thread.latestMessageId,
			ownerAddress: mailbox.address,
			contactId: identity?.contactId,
			transcript,
			answers,
			// No draft exists yet: the web attaches the files when it applies the
			// prepared reply (needsReplyPrepared.getPreparedDraft), so say "will be".
			fileNotes: buildFileAnswerNotes(clarification.questions, 'pending'),
			answeredSlotTypes,
		};
	},
});

/**
 * Persist the starter reply produced by `draftWithAnswers`. Staleness-guarded
 * (a newer inbound message re-triggers the whole flow) and clarification-guarded
 * (the answer must still be present). Flips the card to "Draft ready".
 */
export const persistClarificationDraft = internalMutation({
	args: {
		threadId: v.id('mailThreads'),
		expectedLatestMessageId: v.optional(v.id('mailMessages')),
		draft: v.string(),
	},
	handler: async (ctx, args) => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread) return;
		const flag = thread.needsReply;
		const clarification = flag?.clarification;
		if (!flag || !clarification) return;
		if (
			args.expectedLatestMessageId !== undefined &&
			thread.latestMessageId !== undefined &&
			thread.latestMessageId !== args.expectedLatestMessageId
		) {
			return; // stale — a newer ingest re-enqueued its own check
		}
		await ctx.db.patch(args.threadId, {
			needsReply: {
				...flag,
				clarification: { ...clarification, draft: args.draft.slice(0, 4000) },
			},
			updatedAt: Date.now(),
		});
	},
});
