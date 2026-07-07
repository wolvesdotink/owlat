/**
 * Smart-inbox categories — classify personal (Postbox) mail into
 * person / newsletter / notification / receipt / other so the inbox can be
 * split Spark-style into sections. Advisory and off by default in the UI; this
 * never moves or modifies mail, it only tags the thread for display grouping.
 *
 * Two-stage signal (mirrors the Reply Queue in mail/needsReply.ts):
 *   1. Deterministic heuristic (pure, unit-tested below in
 *      `classifyMailCategory`): List-Unsubscribe / Precedence: bulk → newsletter;
 *      receipt/order/invoice keywords → receipt; no-reply/notification/automated
 *      senders → notification; a known human correspondent (in the address book
 *      / previously written to) → person. Genuinely ambiguous mail returns
 *      `null` and defers to the LLM.
 *   2. Cheap-tier LLM refinement (mail/categoryClassify.ts, 'use node') for the
 *      ambiguous remainder, behind the same aiGate as the rest of Postbox AI.
 *      Fail-soft: any LLM/gate failure leaves the deterministic label (or
 *      `other` when the heuristic was ambiguous).
 *
 * A per-sender user override (mailSenderCategoryOverrides) always wins and is
 * remembered for that sender — see `resolveCategory` and `recategorize`.
 *
 * Trigger: `enqueueCategoryCheck` on inbound webhook delivery (inbox only,
 * bounded to the affected thread), plus a one-shot `backfill` internal action
 * for the most recent inbox threads.
 */

import { v } from 'convex/values';
import {
	internalMutation,
	internalQuery,
	internalAction,
	type MutationCtx,
	type QueryCtx,
} from '../_generated/server';
import { authedMutation } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { throwForbidden, throwNotFound } from '../_utils/errors';
import { isBulkOrNoReplySender } from './needsReply';
import { loadOwnedMailbox } from './permissions';

// ─── Pure deterministic classifier ───────────────────────────────────────────

export const MAIL_CATEGORIES = [
	'person',
	'newsletter',
	'notification',
	'receipt',
	'other',
] as const;
export type MailCategory = (typeof MAIL_CATEGORIES)[number];

/** Categories a user may pick in "Recategorize as…" (no ambiguity there). */
export type MailCategorySource = 'heuristic' | 'llm' | 'user';

/** Subject keywords that mark transactional receipts / orders / invoices. */
const RECEIPT_SUBJECT =
	/\b(receipt|invoice|order\s*(confirmation|#|no\.?|number)?|your\s+order|order\s+shipped|payment\s+(received|confirmation)|purchase|billed|your\s+bill|subscription\s+renew(ed|al)|charged|paid)\b/i;

/** Local-parts of automated/system senders that emit notifications. */
const NOTIFICATION_LOCAL_PART =
	/^(notif(y|ication)?s?|alerts?|updates?|no-?reply|do-?not-?reply|donotreply|system|auto(mated)?|mailer|bot|support|team|hello|info|news|account|security)([+._\-].*)?$/i;

export interface MailCategoryInput {
	/** From address of the latest inbound message (any case). */
	fromAddress: string;
	subject: string;
	/** A List-Unsubscribe target was parsed at ingest (bulk/list mail). */
	hasListUnsubscribe: boolean;
	/** Raw Precedence header value, only known at ingest time. */
	precedence?: string;
	/**
	 * The sender is a known human correspondent: present in the personal
	 * address book, or the owner has previously written to them.
	 */
	isKnownCorrespondent: boolean;
}

/**
 * Deterministic category for a piece of inbound personal mail, or `null` when
 * genuinely ambiguous (defer to the LLM). Pure so it unit-tests without Convex.
 *
 * Order matters: newsletter (bulk header) → receipt (transactional keywords,
 * which often ship from no-reply senders) → notification (automated sender) →
 * person (known human). A known human wins over the ambiguous fallthrough but
 * never over an explicit bulk/receipt/notification signal.
 */
export function classifyMailCategory(input: MailCategoryInput): MailCategory | null {
	// Newsletter: List-Unsubscribe or Precedence: bulk/list — the strongest
	// "this is broadcast mail" signal.
	if (input.hasListUnsubscribe || isBulkPrecedence(input.precedence)) {
		return 'newsletter';
	}

	// Receipt: transactional keywords in the subject. Checked before
	// notification because order confirmations routinely come from no-reply@.
	if (RECEIPT_SUBJECT.test(input.subject)) return 'receipt';

	// Notification: automated / system sender local-parts (incl. the shared
	// no-reply/bounce heuristic used by the Reply Queue).
	const localPart = input.fromAddress.split('@', 1)[0] ?? '';
	const isAutomatedSender =
		NOTIFICATION_LOCAL_PART.test(localPart) ||
		isBulkOrNoReplySender({ fromAddress: input.fromAddress, hasListUnsubscribe: false });
	if (isAutomatedSender) return 'notification';

	// Person: a known human correspondent with no automated markers.
	if (input.isKnownCorrespondent) return 'person';

	// Ambiguous — let the LLM decide (fail-soft `other` at the call site).
	return null;
}

/** Precedence header values that mark bulk/list broadcast mail. */
function isBulkPrecedence(precedence?: string): boolean {
	const p = precedence?.trim().toLowerCase();
	return p === 'bulk' || p === 'list';
}

/**
 * Final category to persist, resolving the three signals by precedence:
 * a user override always wins, then the LLM label, then the deterministic
 * label. Pure — unit-tested for the override-beats-model rule.
 */
export function resolveCategory(opts: {
	override?: MailCategory | null;
	llm?: MailCategory | null;
	deterministic?: MailCategory | null;
}): { label: MailCategory; source: MailCategorySource } {
	if (opts.override) return { label: opts.override, source: 'user' };
	if (opts.llm) return { label: opts.llm, source: 'llm' };
	if (opts.deterministic) return { label: opts.deterministic, source: 'heuristic' };
	// Nothing classified it — everything ungrouped lands in `other`.
	return { label: 'other', source: 'heuristic' };
}

// ─── Trigger helper (called from sibling mail modules) ───────────────────────

/**
 * Schedule category classification for a thread. Called from the inbound
 * webhook delivery path for inbox deliveries only (bulk IMAP backfill must not
 * fan out background work), and from the one-shot `backfill` action.
 */
export async function enqueueCategoryCheck(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	opts: { precedence?: string } = {}
): Promise<void> {
	await ctx.scheduler.runAfter(0, internal.mail.categoryClassify.classifyThread, {
		threadId,
		precedence: opts.precedence,
	});
}

// ─── Convex functions ────────────────────────────────────────────────────────

/** How many newest thread messages the classify action considers. */
export const CATEGORY_CONTEXT_MESSAGES = 4;

/**
 * Bounded thread context for the classify action: owner address, latest
 * inbound message fields (heuristic inputs), whether the sender is a known
 * human correspondent, any remembered user override, and a short transcript.
 */
/**
 * The latest inbound (non-owner) message of a thread — the message whose sender
 * drives the thread's category and the per-sender override key. `latestInbound`
 * is the newest message that is not `outbound` and not from the mailbox owner's
 * own address. Returns `null` for an owner-only thread. Shared by
 * `getThreadCategoryContext` (classify) and `recategorize` (override) so both
 * key on the same address — otherwise an override remembered on send would file
 * under the owner's address and never match future inbound mail.
 */
async function latestInboundMessage(
	ctx: { db: QueryCtx['db'] },
	thread: Doc<'mailThreads'>
): Promise<Doc<'mailMessages'> | null> {
	const mailbox = await ctx.db.get(thread.mailboxId);
	if (!mailbox || mailbox.status !== 'active') return null;
	const ownerAddress = mailbox.address.toLowerCase();

	const all = await ctx.db
		.query('mailMessages')
		.withIndex('by_thread', (q) => q.eq('threadId', thread._id))
		.collect(); // bounded: one thread's messages
	const ordered = all.sort((a, b) => a.receivedAt - b.receivedAt);

	let latestInbound: Doc<'mailMessages'> | undefined;
	for (const m of ordered) {
		const isFromOwner = m.outbound !== undefined || m.fromAddress.toLowerCase() === ownerAddress;
		if (!isFromOwner) latestInbound = m;
	}
	return latestInbound ?? null;
}

export const getThreadCategoryContext = internalQuery({
	args: { threadId: v.id('mailThreads') },
	handler: async (ctx, args) => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread) return null;

		// Latest inbound (not from the owner) message drives the category.
		const latestInbound = await latestInboundMessage(ctx, thread);
		if (!latestInbound) return null; // owner-only thread — nothing to classify

		const all = await ctx.db
			.query('mailMessages')
			.withIndex('by_thread', (q) => q.eq('threadId', args.threadId))
			.collect(); // bounded: one thread's messages
		const ordered = all.sort((a, b) => a.receivedAt - b.receivedAt);

		const senderEmail = latestInbound.fromAddress.toLowerCase();

		// Known human correspondent: in the personal address book, or the owner
		// has previously written to them (both stored in mailContacts, which is
		// populated as the user composes/replies).
		const contact = await ctx.db
			.query('mailContacts')
			.withIndex('by_mailbox_and_email', (q) =>
				q.eq('mailboxId', thread.mailboxId).eq('email', senderEmail)
			)
			.first();

		const override = await ctx.db
			.query('mailSenderCategoryOverrides')
			.withIndex('by_mailbox_and_sender', (q) =>
				q.eq('mailboxId', thread.mailboxId).eq('senderEmail', senderEmail)
			)
			.first();

		const transcript = ordered
			.slice(-CATEGORY_CONTEXT_MESSAGES)
			.map(
				(m) =>
					`From: ${m.fromName || m.fromAddress}\nSubject: ${m.subject}\n${(m.textBodyInline ?? m.snippet ?? '').slice(0, 1500)}`
			)
			.join('\n\n---\n\n')
			.slice(0, 8000);

		return {
			latestMessageId: thread.latestMessageId,
			senderEmail,
			override: override?.label ?? null,
			deterministicInput: {
				fromAddress: latestInbound.fromAddress,
				subject: latestInbound.subject,
				hasListUnsubscribe: latestInbound.unsubscribe !== undefined,
				isKnownCorrespondent: contact !== null,
			},
			transcript,
		};
	},
});

/**
 * Persist a category, guarded against staleness: if a newer message arrived
 * while classification was in flight (thread.latestMessageId moved), a
 * non-user result is dropped — the newer ingest re-enqueued its own check. A
 * `user` override always applies (it is authoritative and set synchronously).
 */
export const applyCategory = internalMutation({
	args: {
		threadId: v.id('mailThreads'),
		expectedLatestMessageId: v.optional(v.id('mailMessages')),
		label: v.union(
			v.literal('person'),
			v.literal('newsletter'),
			v.literal('notification'),
			v.literal('receipt'),
			v.literal('other')
		),
		source: v.union(v.literal('heuristic'), v.literal('llm'), v.literal('user')),
	},
	handler: async (ctx, args) => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread) return;
		if (
			args.source !== 'user' &&
			args.expectedLatestMessageId !== undefined &&
			thread.latestMessageId !== undefined &&
			thread.latestMessageId !== args.expectedLatestMessageId
		) {
			return; // stale — a newer ingest re-enqueued its own check
		}
		await ctx.db.patch(args.threadId, {
			category: { label: args.label, source: args.source, classifiedAt: Date.now() },
			updatedAt: Date.now(),
		});
	},
});

/**
 * User "Recategorize as…" — writes a per-sender override that always wins and
 * is remembered for future mail from that sender, and stamps the thread
 * immediately (source `user`).
 */
// authz: thread → mailbox ownership via loadOwnedMailbox; org membership via
// authedMutation.
export const recategorize = authedMutation({
	args: {
		threadId: v.id('mailThreads'),
		label: v.union(
			v.literal('person'),
			v.literal('newsletter'),
			v.literal('notification'),
			v.literal('receipt'),
			v.literal('other')
		),
	},
	handler: async (ctx, args) => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread) throwNotFound('Thread');
		const owned = await loadOwnedMailbox(ctx, thread.mailboxId);
		if (!owned.ok) throwForbidden('Thread not accessible');

		// Remember the choice per sender, keyed on the latest INBOUND sender — the
		// same address `getThreadCategoryContext` looks the override up by. Keying
		// on `thread.latestFromAddress` would file under the owner's own address on
		// any thread the user last replied to (draftLifecycle advances it to
		// `draft.fromAddress` on send), so future inbound mail would never match.
		const now = Date.now();
		const latestInbound = await latestInboundMessage(ctx, thread);
		if (latestInbound) {
			const senderEmail = latestInbound.fromAddress.toLowerCase();
			const existing = await ctx.db
				.query('mailSenderCategoryOverrides')
				.withIndex('by_mailbox_and_sender', (q) =>
					q.eq('mailboxId', thread.mailboxId).eq('senderEmail', senderEmail)
				)
				.first();
			if (existing) {
				await ctx.db.patch(existing._id, { label: args.label, updatedAt: now });
			} else {
				await ctx.db.insert('mailSenderCategoryOverrides', {
					mailboxId: thread.mailboxId,
					senderEmail,
					label: args.label,
					updatedAt: now,
				});
			}
		}

		await ctx.db.patch(args.threadId, {
			category: { label: args.label, source: 'user', classifiedAt: now },
			updatedAt: now,
		});
	},
});

/** Upper bound on the one-shot backfill (most recent inbox threads). */
const BACKFILL_LIMIT = 500;

/**
 * One-shot backfill: classify the most recent inbox threads that have no
 * category yet. Bounded and idempotent — re-running only touches still-unlabeled
 * threads. Internal (ops-triggered), never on the hot path.
 */
export const backfill = internalAction({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args): Promise<{ scheduled: number }> => {
		const threadIds = await ctx.runQuery(internal.mail.category.listUnclassifiedInbox, {
			mailboxId: args.mailboxId,
		});
		for (const threadId of threadIds) {
			await ctx.runMutation(internal.mail.category.enqueue, { threadId });
		}
		return { scheduled: threadIds.length };
	},
});

/** Most recent inbox threads lacking a category (backfill candidates). */
export const listUnclassifiedInbox = internalQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args): Promise<Id<'mailThreads'>[]> => {
		const threads = await ctx.db
			.query('mailThreads')
			.withIndex('by_mailbox_and_last_message', (q) => q.eq('mailboxId', args.mailboxId))
			.order('desc')
			.take(BACKFILL_LIMIT);
		return threads
			.filter((t) => t.folderRoles.includes('inbox') && t.category === undefined)
			.map((t) => t._id);
	},
});

/** Mutation wrapper so the backfill action can schedule via the shared helper. */
export const enqueue = internalMutation({
	args: { threadId: v.id('mailThreads') },
	handler: async (ctx, args) => {
		await enqueueCategoryCheck(ctx, args.threadId);
	},
});
