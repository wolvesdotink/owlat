/**
 * Reply Queue foundation — detect and track "needs a reply from me" on
 * personal (Postbox) mail threads.
 *
 * Two-stage signal:
 *   1. Deterministic base heuristic (pure, unit-tested below in
 *      `evaluateNeedsReplyCandidate`): the latest inbound message addresses
 *      the owner in To (not only Cc), is not from a no-reply/bulk sender
 *      (List-Unsubscribe / Precedence: bulk / no-reply local-parts), and the
 *      owner has not sent a later message in the thread.
 *   2. Cheap-tier LLM refinement (mail/needsReplyClassify.ts, 'use node')
 *      that classifies candidates: needsReply, urgency, askSummary, dueHint.
 *      Fail-soft: any LLM/gate failure leaves the deterministic candidate
 *      flag with urgency `normal` and no askSummary.
 *
 * Trigger: `enqueueNeedsReplyCheck` on inbound webhook delivery (bounded to
 * the affected thread), plus a reconcile cron (`sweepPending`) that
 * re-schedules threads whose scheduled classification was lost.
 *
 * Clearing: any outbound send in the thread (draftLifecycle sent-effects),
 * archiving/trashing its messages (messageActions.move), or the manual
 * `clear` mutation for the UI.
 */

import { v, type Infer } from 'convex/values';
import { internalMutation, internalQuery, type MutationCtx } from '../_generated/server';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { throwForbidden, throwInvalidInput, throwNotFound } from '../_utils/errors';
import { isMessageSnoozed } from '../lib/mailSnooze';
import { loadOwnedMailbox, loadReadableMailbox } from './permissions';

// ─── Deterministic heuristic (pure) ─────────────────────────────────────────

/** Local-parts that never expect a reply (automated / bounce senders). */
const NO_REPLY_LOCAL_PART =
	/^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounce(s)?|notification(s)?|alerts?|newsletter|marketing|updates?)([+._\-].*)?$/i;

/** Precedence header values that mark bulk/automated mail (RFC 2076 §3.9). */
const BULK_PRECEDENCE = new Set(['bulk', 'list', 'junk', 'auto_reply']);

export interface NeedsReplyMessageInput {
	fromAddress: string;
	toAddresses: string[];
	ccAddresses: string[];
	/** A List-Unsubscribe target was parsed at ingest (bulk/list mail). */
	hasListUnsubscribe: boolean;
	/** Sent by the mailbox owner (outbound / self-sent). */
	isFromOwner: boolean;
	receivedAt: number;
}

export type NeedsReplyEvaluation =
	| { candidate: true; latestInboundIndex: number }
	| {
			candidate: false;
			reason: 'no_inbound' | 'owner_replied' | 'bulk_sender' | 'not_in_to';
	  };

/** True when the sender looks like bulk/no-reply mail nobody should answer. */
export function isBulkOrNoReplySender(msg: {
	fromAddress: string;
	hasListUnsubscribe: boolean;
	/** Raw Precedence header value, only known at ingest time. */
	precedence?: string;
}): boolean {
	if (msg.hasListUnsubscribe) return true;
	const precedence = msg.precedence?.trim().toLowerCase();
	if (precedence && BULK_PRECEDENCE.has(precedence)) return true;
	const localPart = msg.fromAddress.split('@', 1)[0] ?? '';
	return NO_REPLY_LOCAL_PART.test(localPart);
}

/**
 * Deterministic "needs a reply from me" candidate check over a thread's
 * messages (any order). Pure so it unit-tests without Convex.
 *
 * `precedence` applies to the latest inbound message only — the header is not
 * persisted on the row, so it is available at ingest but not on re-sweeps.
 */
export function evaluateNeedsReplyCandidate(opts: {
	/** Lowercased addresses that count as "me" (mailbox address). */
	ownerAddresses: string[];
	messages: NeedsReplyMessageInput[];
	precedence?: string;
}): NeedsReplyEvaluation {
	const owners = new Set(opts.ownerAddresses.map((a) => a.toLowerCase()));
	const ordered = opts.messages
		.map((m, index) => ({ m, index }))
		.sort((a, b) => a.m.receivedAt - b.m.receivedAt);

	let latestInbound: { m: NeedsReplyMessageInput; index: number } | undefined;
	for (const entry of ordered) {
		if (!entry.m.isFromOwner && !owners.has(entry.m.fromAddress.toLowerCase())) {
			latestInbound = entry;
		}
	}
	if (!latestInbound) return { candidate: false, reason: 'no_inbound' };

	// Owner sent a later message → already replied (or moved on).
	const ownerRepliedAfter = ordered.some(
		(e) =>
			(e.m.isFromOwner || owners.has(e.m.fromAddress.toLowerCase())) &&
			e.m.receivedAt >= latestInbound.m.receivedAt,
	);
	if (ownerRepliedAfter) return { candidate: false, reason: 'owner_replied' };

	if (
		isBulkOrNoReplySender({
			fromAddress: latestInbound.m.fromAddress,
			hasListUnsubscribe: latestInbound.m.hasListUnsubscribe,
			precedence: opts.precedence,
		})
	) {
		return { candidate: false, reason: 'bulk_sender' };
	}

	// Addressed to me directly (To), not only Cc'd.
	const inTo = latestInbound.m.toAddresses.some((a) => owners.has(a.toLowerCase()));
	if (!inTo) return { candidate: false, reason: 'not_in_to' };

	return { candidate: true, latestInboundIndex: latestInbound.index };
}

/** True when an attachment is a calendar invite (.ics / text/calendar). */
export function isCalendarAttachment(att: {
	filename: string;
	contentType: string;
}): boolean {
	return (
		att.contentType.toLowerCase().includes('calendar') ||
		att.filename.toLowerCase().endsWith('.ics')
	);
}

// ─── Trigger + clearing helpers (called from sibling mail modules) ──────────

/** How many newest thread messages the classify action considers. */
export const NEEDS_REPLY_CONTEXT_MESSAGES = 6;

/**
 * Mark the thread pending and schedule the classify action. Called from the
 * inbound webhook delivery path (deliverToMailbox) for inbox deliveries only —
 * external IMAP backfill ingests old mail in bulk and must not fan out LLM
 * work; the reconcile cron stays bounded the same way.
 */
export async function enqueueNeedsReplyCheck(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	opts: { precedence?: string } = {},
): Promise<void> {
	await ctx.db.patch(threadId, {
		needsReplyPendingAt: Date.now(),
		updatedAt: Date.now(),
	});
	await ctx.scheduler.runAfter(0, internal.mail.needsReplyClassify.classifyThread, {
		threadId,
		precedence: opts.precedence,
	});
}

/** Unset the needs-reply flag (and any pending marker) on a thread. */
export async function clearThreadNeedsReply(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
): Promise<void> {
	const thread = await ctx.db.get(threadId);
	if (!thread) return;
	if (thread.needsReply === undefined && thread.needsReplyPendingAt === undefined) return;
	await ctx.db.patch(threadId, {
		needsReply: undefined,
		needsReplyPendingAt: undefined,
		updatedAt: Date.now(),
	});
}

// ─── Convex functions ────────────────────────────────────────────────────────

/**
 * Bounded thread context for the classify action: the mailbox owner address
 * plus the newest messages (heuristic inputs + a short transcript for the
 * LLM refinement prompt).
 */
export const getThreadContext = internalQuery({
	args: { threadId: v.id('mailThreads') },
	handler: async (ctx, args) => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread) return null;
		const mailbox = await ctx.db.get(thread.mailboxId);
		if (!mailbox || mailbox.status !== 'active') return null;
		const all = await ctx.db
			.query('mailMessages')
			.withIndex('by_thread', (q) => q.eq('threadId', args.threadId))
			.collect();
		const newest = all
			.sort((a, b) => a.receivedAt - b.receivedAt)
			.slice(-NEEDS_REPLY_CONTEXT_MESSAGES);
		const ownerAddress = mailbox.address.toLowerCase();
		return {
			ownerAddress,
			latestMessageId: thread.latestMessageId,
			messages: newest.map((m) => ({
				messageId: m._id,
				fromAddress: m.fromAddress,
				fromName: m.fromName,
				toAddresses: m.toAddresses,
				ccAddresses: m.ccAddresses,
				hasListUnsubscribe: m.unsubscribe !== undefined,
				// A real calendar invite (.ics) is handled by PostboxInviteCard —
				// the scheduling chip must never double up on it.
				hasCalendarInvite: (m.attachments ?? []).some(isCalendarAttachment),
				isFromOwner:
					m.outbound !== undefined || m.fromAddress.toLowerCase() === ownerAddress,
				receivedAt: m.receivedAt,
				subject: m.subject,
				// Short bounded body excerpt — the refinement prompt does not need
				// the full message, and snippet is always present.
				excerpt: (m.textBodyInline ?? m.snippet ?? '').slice(0, 2000),
			})),
		};
	},
});

/**
 * Persisted clarification shape on `needsReply.clarification` (mirrors
 * schema/mail.ts). Set by the refinement pass when a good reply needs a fact
 * only the owner can supply; the owner answers it inline in the Reply Queue.
 */
const clarificationFlagValidator = v.object({
	isNeeded: v.boolean(),
	questions: v.array(
		v.object({
			id: v.string(),
			slotType: v.string(),
			text: v.string(),
			attribution: v.string(),
			options: v.optional(v.array(v.string())),
			answer: v.optional(v.object({ value: v.string(), at: v.number() })),
		}),
	),
	askedAt: v.number(),
	answeredAt: v.optional(v.number()),
	draft: v.optional(v.string()),
});

const needsReplyResultValidator = v.union(
	v.null(),
	v.object({
		messageId: v.id('mailMessages'),
		source: v.union(v.literal('heuristic'), v.literal('llm')),
		urgency: v.union(v.literal('high'), v.literal('normal'), v.literal('low')),
		askSummary: v.optional(v.string()),
		dueHint: v.optional(v.string()),
		meetingIntent: v.optional(v.object({
			isScheduling: v.boolean(),
			proposedTimes: v.array(v.string()),
			topic: v.optional(v.string()),
		})),
		clarification: v.optional(clarificationFlagValidator),
	}),
);

/**
 * Persist a classification result and clear the pending marker. Guarded
 * against staleness: if a newer message arrived while classification was in
 * flight (thread.latestMessageId moved), the result is dropped — the newer
 * ingest already re-enqueued a check.
 */
export const applyResult = internalMutation({
	args: {
		threadId: v.id('mailThreads'),
		/** thread.latestMessageId observed by getThreadContext. */
		expectedLatestMessageId: v.optional(v.id('mailMessages')),
		needsReply: needsReplyResultValidator,
	},
	handler: async (ctx, args) => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread) return;
		if (
			args.expectedLatestMessageId !== undefined &&
			thread.latestMessageId !== undefined &&
			thread.latestMessageId !== args.expectedLatestMessageId
		) {
			return; // stale — a newer ingest re-enqueued its own check
		}
		await ctx.db.patch(args.threadId, {
			needsReply:
				args.needsReply === null
					? undefined
					: { ...args.needsReply, detectedAt: Date.now() },
			needsReplyPendingAt: undefined,
			updatedAt: Date.now(),
		});
	},
});

/** Upper bound on Reply Queue rows returned per query (joins one message each). */
const QUEUE_LIMIT = 100;

/**
 * The Reply Queue — every thread in the mailbox currently flagged as
 * "needs a reply from me", joined with the message that triggered the flag.
 *
 * Live by construction: replying (draftLifecycle sent-effects), archiving /
 * trashing (messageActions.move) and the manual `clear` mutation all unset
 * `needsReply`, so subscribed clients drop the row without a manual refresh.
 * Snoozed trigger messages are hidden here the same way the inbox hides them —
 * the wakeup cron floats them back. Ranking (urgency, then age) is a pure
 * client-side comparator so it stays unit-testable; this returns newest-first
 * up to the cap.
 */
// public: soft-auth — returns empty for anonymous; mailbox ownership is still enforced in-handler
export const listQueue = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const mailbox = await loadReadableMailbox(ctx, args.mailboxId);
		if (!mailbox) return { items: [] };

		const now = Date.now();
		const threads = await ctx.db
			.query('mailThreads')
			.withIndex('by_mailbox_needs_reply', (q) =>
				q.eq('mailboxId', args.mailboxId).gt('needsReply.detectedAt', 0),
			)
			.order('desc')
			.take(QUEUE_LIMIT);

		const items = [];
		for (const thread of threads) {
			const flag = thread.needsReply;
			if (!flag) continue;
			const message = await ctx.db.get(flag.messageId);
			if (!message) continue;
			// Snoozed = deliberately deferred; it re-enters the queue on wakeup.
			if (isMessageSnoozed(message, now)) continue;
			items.push({
				kind: 'needs_reply' as const,
				threadId: thread._id,
				messageId: flag.messageId,
				urgency: flag.urgency,
				askSummary: flag.askSummary,
				dueHint: flag.dueHint,
				detectedAt: flag.detectedAt,
				source: flag.source,
				waitingOn: undefined as string | undefined,
				// Clarification loop: when present, the row renders as a "Needs your
				// input" card (question + scoped chips + free-text) instead of the
				// plain needs-reply row. Absent for the deterministic/plain case.
				clarification: flag.clarification,
				fromAddress: message.fromAddress,
				fromName: message.fromName,
				subject: message.subject,
				snippet: thread.latestSnippet,
				receivedAt: message.receivedAt,
			});
		}

		// Follow-up items — sent mail whose "remind me if no reply" deadline
		// passed (mail/followUps.ts sweep stamped followUp.dueAt). Deterministic;
		// cleared by any inbound reply or the cancel/dismiss mutation.
		const dueFollowUps = await ctx.db
			.query('mailThreads')
			.withIndex('by_mailbox_follow_up_due', (q) =>
				q.eq('mailboxId', args.mailboxId).gt('followUp.dueAt', 0),
			)
			.order('desc')
			.take(QUEUE_LIMIT);
		for (const thread of dueFollowUps) {
			const flag = thread.followUp;
			if (!flag || flag.dueAt === undefined) continue;
			const message = await ctx.db.get(flag.messageId);
			if (!message) continue;
			if (isMessageSnoozed(message, now)) continue;
			items.push({
				kind: 'followup' as const,
				threadId: thread._id,
				messageId: flag.messageId,
				urgency: 'normal' as const,
				askSummary: undefined,
				dueHint: undefined,
				detectedAt: flag.dueAt,
				source: 'heuristic' as const,
				waitingOn: flag.waitingOn,
				clarification: undefined as Infer<typeof clarificationFlagValidator> | undefined,
				// The counterpart shown on the card is who we're waiting ON.
				fromAddress: flag.waitingOn ?? message.toAddresses[0] ?? message.fromAddress,
				fromName: undefined,
				subject: message.subject,
				snippet: thread.latestSnippet,
				receivedAt: message.receivedAt,
			});
		}
		return { items };
	},
});

/** Manual clear for the UI ("mark as done" on the Reply Queue). */
// authz: thread → mailbox ownership via loadOwnedMailbox; org membership via
// authedMutation.
export const clear = authedMutation({
	args: { threadId: v.id('mailThreads') },
	handler: async (ctx, args) => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread) throwNotFound('Thread');
		const owned = await loadOwnedMailbox(ctx, thread.mailboxId);
		if (!owned.ok) throwForbidden('Thread not accessible');
		await clearThreadNeedsReply(ctx, args.threadId);
	},
});

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

/** Pending markers older than this are considered lost and re-scheduled. */
const SWEEP_MIN_AGE_MS = 5 * 60 * 1000;
const SWEEP_BATCH = 20;

/**
 * Reconcile cron: re-schedule classification for threads whose enqueued check
 * never completed (deploy restart, lost scheduled action). Bounded per tick;
 * bumping `needsReplyPendingAt` keeps a permanently-failing thread from being
 * re-picked every tick while it ages back into the window.
 */
export const sweepPending = internalMutation({
	args: {},
	handler: async (ctx) => {
		const cutoff = Date.now() - SWEEP_MIN_AGE_MS;
		// `needsReplyPendingAt` is optional: on the index, `undefined` rows sort
		// before every number, so lower-bound with gt(0) (same trick as the
		// snooze sweep) to skip the never-pending majority.
		const stale: Doc<'mailThreads'>[] = await ctx.db
			.query('mailThreads')
			.withIndex('by_needs_reply_pending', (q) =>
				q.gt('needsReplyPendingAt', 0).lte('needsReplyPendingAt', cutoff),
			)
			.take(SWEEP_BATCH);
		for (const thread of stale) {
			await ctx.db.patch(thread._id, { needsReplyPendingAt: Date.now() });
			await ctx.scheduler.runAfter(0, internal.mail.needsReplyClassify.classifyThread, {
				threadId: thread._id,
			});
		}
		return { rescheduled: stale.length };
	},
});
