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
import { openMailMessageInlineBody } from '../lib/messageBody';
import { internalMutation, internalQuery, type MutationCtx } from '../_generated/server';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { getOrThrow, throwForbidden } from '../_utils/errors';
import { isMessageSnoozed } from '../lib/mailSnooze';
import { requireMailboxAccess, loadReadableMailbox } from './permissions';
import { urgencyFallbackScore } from './priorityScore';
import { scoreAndScreenResult } from './needsReplyScoring';
import { isFeatureEnabled } from '../lib/featureFlags';

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
			e.m.receivedAt >= latestInbound.m.receivedAt
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
export function isCalendarAttachment(att: { filename: string; contentType: string }): boolean {
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
	opts: { precedence?: string } = {}
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
	threadId: Id<'mailThreads'>
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
			.collect(); // bounded: one thread's messages
		const newest = all
			.sort((a, b) => a.receivedAt - b.receivedAt)
			.slice(-NEEDS_REPLY_CONTEXT_MESSAGES);
		const ownerAddress = mailbox.address.toLowerCase();
		return {
			ownerAddress,
			latestMessageId: thread.latestMessageId,
			messages: await Promise.all(
				newest.map(async (m) => ({
					messageId: m._id,
					fromAddress: m.fromAddress,
					fromName: m.fromName,
					toAddresses: m.toAddresses,
					ccAddresses: m.ccAddresses,
					hasListUnsubscribe: m.unsubscribe !== undefined,
					// A real calendar invite (.ics) is handled by PostboxInviteCard —
					// the scheduling chip must never double up on it.
					hasCalendarInvite: (m.attachments ?? []).some(isCalendarAttachment),
					isFromOwner: m.outbound !== undefined || m.fromAddress.toLowerCase() === ownerAddress,
					receivedAt: m.receivedAt,
					subject: m.subject,
					// Short bounded body excerpt — the refinement prompt does not need
					// the full message, and snippet is always present.
					excerpt: ((await openMailMessageInlineBody(m)).text ?? m.snippet ?? '').slice(0, 2000),
				}))
			),
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
		})
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
		// Blended sender-importance × urgency score — the ranking key. Computed in
		// applyResult (server-side) from the address book, never sent by callers.
		priorityScore: v.optional(v.number()),
		askSummary: v.optional(v.string()),
		dueHint: v.optional(v.string()),
		meetingIntent: v.optional(
			v.object({
				isScheduling: v.boolean(),
				proposedTimes: v.array(v.string()),
				topic: v.optional(v.string()),
			})
		),
		clarification: v.optional(clarificationFlagValidator),
	})
);

/**
 * Persist a classification result and clear the pending marker. Guarded
 * against staleness: if a newer message arrived while classification was in
 * flight (thread.latestMessageId moved), the result is dropped — the newer
 * ingest already re-enqueued a check.
 *
 * When a result is being set, this is also the single place the unified
 * priority score is computed (from the address book, server-side) and the
 * HEY-style screener gate is applied — an unknown first-time sender is held
 * OUT of the queue (result forced to null) when the owner enabled the screener.
 * Fail-soft: a missing message/mailbox row falls back to persisting the result
 * without a score rather than dropping the signal.
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

		let resolved = args.needsReply;
		if (resolved !== null) {
			const message = await ctx.db.get(resolved.messageId);
			const mailbox = await ctx.db.get(thread.mailboxId);
			if (message && mailbox) {
				// Single write point for the unified priority score + the HEY-style
				// screener gate (mail/needsReplyScoring.ts). Fail-soft: a missing
				// message/mailbox row skips scoring and persists the raw result.
				resolved = await scoreAndScreenResult(ctx, {
					mailboxId: thread.mailboxId,
					ownerUserId: mailbox.userId,
					message,
					resolved,
				});
			}
		}

		await ctx.db.patch(args.threadId, {
			needsReply: resolved === null ? undefined : { ...resolved, detectedAt: Date.now() },
			needsReplyPendingAt: undefined,
			updatedAt: Date.now(),
		});

		// Draft-on-arrival (postbox.aiDraft): the moment a message is confirmed to
		// need a reply, pre-generate a draft into the review slot via the shared
		// draft service. Flag-gated + fully async (own action) + fail-soft: it
		// never blocks classification and degrades to no slot when AI is off.
		if (resolved !== null && (await isFeatureEnabled(ctx, 'postbox.aiDraft'))) {
			await ctx.scheduler.runAfter(0, internal.mail.draftOnArrival.generateForThread, {
				threadId: args.threadId,
			});
		}
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
// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const listQueue = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const mailbox = await loadReadableMailbox(ctx, args.mailboxId);
		if (!mailbox) return { items: [] };

		const now = Date.now();
		const threads = await ctx.db
			.query('mailThreads')
			.withIndex('by_mailbox_needs_reply', (q) =>
				q.eq('mailboxId', args.mailboxId).gt('needsReply.detectedAt', 0)
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
				// Ranking key — sender-importance × urgency blend. Falls back to the
				// urgency bucket for rows persisted before scoring existed.
				priorityScore: flag.priorityScore ?? urgencyFallbackScore(flag.urgency),
				askSummary: flag.askSummary,
				dueHint: flag.dueHint,
				detectedAt: flag.detectedAt,
				source: flag.source,
				waitingOn: undefined as string | undefined,
				// Clarification loop: when present, the row renders as a "Needs your
				// input" card (question + scoped chips + free-text) instead of the
				// plain needs-reply row. Absent for the deterministic/plain case.
				clarification: flag.clarification,
				// Draft-on-arrival review slot (postbox.aiDraft): a pre-generated reply
				// + confidence/quality, reviewed-and-sent by the owner. Absent when the
				// flag is off or generation hasn't landed / failed. Never auto-sent.
				draftSlot: flag.draftSlot,
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
				q.eq('mailboxId', args.mailboxId).gt('followUp.dueAt', 0)
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
				// Follow-ups have no sender-importance signal — rank at the plain
				// 'normal' urgency baseline so they interleave with needs-reply rows.
				priorityScore: urgencyFallbackScore('normal'),
				askSummary: undefined,
				dueHint: undefined,
				detectedAt: flag.dueAt,
				source: 'heuristic' as const,
				waitingOn: flag.waitingOn,
				clarification: undefined as Infer<typeof clarificationFlagValidator> | undefined,
				draftSlot: undefined,
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
// authz: thread → mailbox access via requireMailboxAccess; org membership via
// authedMutation.
export const clear = authedMutation({
	args: { threadId: v.id('mailThreads') },
	handler: async (ctx, args) => {
		const thread = await getOrThrow(ctx, args.threadId, 'Thread');
		const owned = await requireMailboxAccess(ctx, thread.mailboxId);
		if (!owned.ok) throwForbidden('Thread not accessible');
		await clearThreadNeedsReply(ctx, args.threadId);
	},
});

/**
 * Pending markers older than this are considered lost and re-scheduled.
 *
 * The Postbox clarification loop (answerClarification, getClarificationContext,
 * persistClarificationDraft) lives in the sibling `mail/needsReplyClarify.ts`
 * to keep this file under the domain-file size gate.
 */
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
				q.gt('needsReplyPendingAt', 0).lte('needsReplyPendingAt', cutoff)
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
