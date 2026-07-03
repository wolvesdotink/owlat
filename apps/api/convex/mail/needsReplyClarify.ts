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
import { internalMutation, internalQuery } from '../_generated/server';
import { authedMutation } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { throwForbidden, throwInvalidInput, throwNotFound } from '../_utils/errors';
import { loadOwnedMailbox } from './permissions';
import { NEEDS_REPLY_CONTEXT_MESSAGES } from './needsReply';

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
// authz: thread → mailbox ownership via loadOwnedMailbox; org membership via
// authedMutation.
export const answerClarification = authedMutation({
	args: {
		threadId: v.id('mailThreads'),
		answers: v.array(v.object({ questionId: v.string(), value: v.string() })),
	},
	handler: async (ctx, args) => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread) throwNotFound('Thread');
		const owned = await loadOwnedMailbox(ctx, thread.mailboxId);
		if (!owned.ok) throwForbidden('Thread not accessible');

		const flag = thread.needsReply;
		const clarification = flag?.clarification;
		if (!flag || !clarification) throwNotFound('Clarification');

		const now = Date.now();
		const answerByQuestion = new Map(
			args.answers.map((a) => [a.questionId, a.value] as const),
		);
		// Guard: at least one submitted answer must map to a real question before
		// we stamp the clarification answered + schedule the draft. A payload that
		// matches nothing would otherwise mark it answered with zero recorded
		// answers, so draftWithAnswers produces no draft and the card strands in
		// 'drafting' forever. Reject instead of silently answering nothing.
		let matched = 0;
		for (const q of clarification.questions) {
			if (answerByQuestion.has(q.id)) matched += 1;
		}
		if (matched === 0) throwInvalidInput('No answer matches an open question');

		const questions = clarification.questions.map((q) => {
			const value = answerByQuestion.get(q.id);
			if (value === undefined) return q;
			return { ...q, answer: { value: value.slice(0, 2000), at: now } };
		});

		await ctx.db.patch(args.threadId, {
			needsReply: {
				...flag,
				clarification: { ...clarification, questions, answeredAt: now, isNeeded: false },
			},
			updatedAt: now,
		});

		// Off the scheduler — the answer is already committed above.
		await ctx.scheduler.runAfter(0, internal.mail.needsReplyClassify.draftWithAnswers, {
			threadId: args.threadId,
		});

		return { success: true };
	},
});

/**
 * Bounded context for the `draftWithAnswers` action: the mailbox id, a short
 * transcript of the newest messages, and the owner's confirmed answers folded
 * into `question: answer` lines. Null when the clarification is gone / stale.
 */
export const getClarificationContext = internalQuery({
	args: { threadId: v.id('mailThreads') },
	handler: async (ctx, args) => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread) return null;
		const clarification = thread.needsReply?.clarification;
		if (!clarification || clarification.answeredAt === undefined) return null;
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
		const transcript = newest
			.map(
				(m) =>
					`From: ${m.fromName || m.fromAddress}\nSubject: ${m.subject}\n${(m.textBodyInline ?? m.snippet ?? '').slice(0, 2000)}`,
			)
			.join('\n\n---\n\n')
			.slice(0, 12000);

		const answers = [];
		for (const q of clarification.questions) {
			if (q.answer) answers.push({ question: q.text, answer: q.answer.value });
		}

		return {
			mailboxId: thread.mailboxId,
			latestMessageId: thread.latestMessageId,
			transcript,
			answers,
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
