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
 *   2. Cheap-tier LLM refinement (mail/ai/categoryClassify.ts, 'use node') for the
 *      ambiguous remainder, behind the same aiGate as the rest of Postbox AI.
 *      Fail-soft: any LLM/gate failure leaves the deterministic label (or
 *      `other` when the heuristic was ambiguous, or the thread's standing LLM
 *      label on an ambiguous follow-up).
 *
 * A per-sender user override (mailSenderCategoryOverrides) always wins and is
 * remembered for that sender — see `resolveCategory` and `recategorize`.
 *
 * Trigger: `enqueueCategoryCheck` (mail/categoryArrival.ts) on inbound webhook
 * delivery and on forward external IMAP sync (inbox only, bounded to the
 * affected thread; a historical import never enqueues), plus the hand-run
 * `migrations/0037_backfill_mail_categories:run` for recent existing threads.
 * The override and the heuristic run inside the calling mutation, so a thread
 * arrives already labelled; only the ambiguous remainder schedules the LLM.
 */

import { v, type Infer } from 'convex/values';
import {
	internalMutation,
	internalQuery,
	type MutationCtx,
	type QueryCtx,
} from '../_generated/server';
import { postboxMutation } from './_helpers';
import type { Doc, Id } from '../_generated/dataModel';
import { getOrThrow, throwForbidden } from '../_utils/errors';
import { isBulkOrNoReplySender } from './needsReplyHeuristic';
import { buildThreadTranscript, CATEGORY } from './ai/transcript';
import { withStoredInlineBodies } from '../lib/messageBodyStore';
import { requireMailboxAccess } from './permissions';
import { moveMessagesToFolder } from './messageActions';
import { mailCategoryLabelValidator, mailCategorySourceValidator } from '../lib/literalValidators';

// ─── Pure deterministic classifier ───────────────────────────────────────────

/** A smart-inbox category label; the schema validator is the one list. */
export type MailCategory = Infer<typeof mailCategoryLabelValidator>;

/** Who assigned the label (`user` = a remembered per-sender override). */
type MailCategorySource = Infer<typeof mailCategorySourceValidator>;

/** Subject keywords that mark transactional receipts / orders / invoices. */
const RECEIPT_SUBJECT =
	/\b(receipt|invoice|order\s*(confirmation|#|no\.?|number)?|your\s+order|order\s+shipped|payment\s+(received|confirmation)|purchase|billed|your\s+bill|subscription\s+renew(ed|al)|charged|paid)\b/i;

/**
 * Subject phrases that mark a promotion: a sale, a discount, a limited offer.
 * Checked AFTER the newsletter signal (a subscribed newsletter announcing a
 * sale is still the newsletter the owner asked for) and BEFORE receipts.
 */
const PROMOTION_SUBJECT =
	/(\b\d{1,2}\s?%\s?(off|rabatt|discount)|\b(sale|flash\s+sale|limited[-\s]time|last\s+chance|exclusive\s+offer|special\s+offer|coupon|promo\s*code|voucher|black\s+friday|cyber\s+monday|free\s+trial|upgrade\s+now|don'?t\s+miss|angebot|gutschein|aktion)\b)/i;

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

	// Promotion: sale / discount / offer phrasing from a sender the owner has
	// never written to. A known correspondent announcing a sale is a person.
	if (!input.isKnownCorrespondent && PROMOTION_SUBJECT.test(input.subject)) return 'promotion';

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

// ─── Convex functions ────────────────────────────────────────────────────────

/** How many newest thread messages the classify action considers. */
const CATEGORY_CONTEXT_MESSAGES = 4;

/**
 * The latest inbound (non-owner) message of a thread — the message whose sender
 * drives the thread's category and the per-sender override key. `latestInbound`
 * is the newest message that is not `outbound` and not from the mailbox owner's
 * own address. Returns `null` for an owner-only thread. Shared (through
 * `threadInboundView`) by classification and `recategorize` (override) so both
 * key on the same address — otherwise an override remembered on send would file
 * under the owner's address and never match future inbound mail.
 */
async function latestInboundMessage(
	ctx: { db: QueryCtx['db'] },
	thread: Doc<'mailThreads'>
): Promise<Doc<'mailMessages'> | null> {
	return (await threadInboundView(ctx, thread))?.latestInbound ?? null;
}

/** The thread's messages oldest-first plus its latest inbound one (see above). */
async function threadInboundView(
	ctx: { db: QueryCtx['db'] },
	thread: Doc<'mailThreads'>
): Promise<{ ordered: Doc<'mailMessages'>[]; latestInbound: Doc<'mailMessages'> } | null> {
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
	return latestInbound ? { ordered, latestInbound } : null;
}

/**
 * The classifier's inputs for a thread, minus the LLM transcript: the latest
 * inbound sender, any remembered override for them, and the heuristic's
 * fields. Shared by the in-mutation pass (`mail/categoryArrival.ts`, which
 * finds `latestInbound` with a bounded newest-first read) and the LLM action's
 * context query (which reads the whole thread for its transcript anyway) so
 * both decide on the same signals.
 */
export async function loadCategorySignals(
	ctx: { db: QueryCtx['db'] },
	thread: Doc<'mailThreads'>,
	latestInbound: Doc<'mailMessages'>
) {
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

	return {
		senderEmail,
		override: override?.label ?? null,
		deterministicInput: {
			fromAddress: latestInbound.fromAddress,
			subject: latestInbound.subject,
			hasListUnsubscribe: latestInbound.unsubscribe !== undefined,
			isKnownCorrespondent: contact !== null,
		},
	};
}

/**
 * Bounded thread context for the classify action: latest inbound message
 * fields (heuristic inputs), whether the sender is a known human
 * correspondent, any remembered user override, and a short transcript.
 */
export const getThreadCategoryContext = internalQuery({
	args: { threadId: v.id('mailThreads') },
	handler: async (ctx, args) => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread) return null;

		// Latest inbound (not from the owner) message drives the category.
		const view = await threadInboundView(ctx, thread);
		if (!view) return null; // owner-only thread — nothing to classify
		const signals = await loadCategorySignals(ctx, thread, view.latestInbound);

		const transcript = await buildThreadTranscript(
			await withStoredInlineBodies(ctx.db, view.ordered.slice(-CATEGORY_CONTEXT_MESSAGES)),
			CATEGORY
		);

		return {
			latestMessageId: thread.latestMessageId,
			senderEmail: signals.senderEmail,
			override: signals.override,
			deterministicInput: signals.deterministicInput,
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
		label: mailCategoryLabelValidator,
		source: mailCategorySourceValidator,
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
		await writeCategory(ctx, thread, args.label, args.source);
	},
});

/**
 * Stamp a thread's category. Spam goes to the Spam folder the moment the
 * classifier says so; the thread keeps its label, so "Not spam"
 * (recategorize) can bring it back.
 */
export async function writeCategory(
	ctx: MutationCtx,
	thread: Doc<'mailThreads'>,
	label: MailCategory,
	source: MailCategorySource
): Promise<void> {
	const previous = thread.category?.label;
	const now = Date.now();
	await ctx.db.patch(thread._id, {
		category: { label, source, classifiedAt: now },
		updatedAt: now,
	});
	if (label === 'spam' && previous !== 'spam') {
		await moveThreadBetweenRoles(ctx, thread, 'inbox', 'spam');
	}
}

/**
 * Move every message of `thread` that sits in the `fromRole` system folder
 * into the `toRole` one. Best-effort: a mailbox without the target folder, or
 * a thread with nothing in the source folder, is a no-op. Reuses the one
 * bookkeeping helper every folder move goes through.
 */
async function moveThreadBetweenRoles(
	ctx: MutationCtx,
	thread: Doc<'mailThreads'>,
	fromRole: 'inbox' | 'spam',
	toRole: 'inbox' | 'spam'
): Promise<void> {
	const source = await ctx.db
		.query('mailFolders')
		.withIndex('by_mailbox_and_role', (q) =>
			q.eq('mailboxId', thread.mailboxId).eq('role', fromRole)
		)
		.first();
	const target = await ctx.db
		.query('mailFolders')
		.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', thread.mailboxId).eq('role', toRole))
		.first();
	if (!source || !target) return;
	const messages = await ctx.db
		.query('mailMessages')
		.withIndex('by_thread', (q) => q.eq('threadId', thread._id))
		.collect(); // bounded: one thread's messages
	const messageIds = messages.filter((m) => m.folderId === source._id).map((m) => m._id);
	if (messageIds.length === 0) return;
	await moveMessagesToFolder(ctx, { messageIds, targetFolderId: target._id });
}

/**
 * User "Recategorize as…" — writes a per-sender override that always wins and
 * is remembered for future mail from that sender, and stamps the thread
 * immediately (source `user`).
 */
// authz: thread → mailbox access via requireMailboxAccess; org membership via
// authedMutation.
export const recategorize = postboxMutation({
	args: {
		threadId: v.id('mailThreads'),
		label: mailCategoryLabelValidator,
	},
	handler: async (ctx, args) => {
		const thread = await getOrThrow(ctx, args.threadId, 'Thread');
		const owned = await requireMailboxAccess(ctx, thread.mailboxId);
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

		const previous = thread.category?.label;
		await ctx.db.patch(args.threadId, {
			category: { label: args.label, source: 'user', classifiedAt: now },
			updatedAt: now,
		});
		// The owner is in charge: marking spam files it away, and "Not spam" —
		// any other label on a thread the classifier filed as spam — brings the
		// messages back to the inbox. The per-sender override above makes sure
		// the classifier never files that sender as spam again.
		if (args.label === 'spam' && previous !== 'spam') {
			await moveThreadBetweenRoles(ctx, thread, 'inbox', 'spam');
		} else if (args.label !== 'spam' && previous === 'spam') {
			await moveThreadBetweenRoles(ctx, thread, 'spam', 'inbox');
		}
	},
});

/** Upper bound on the one-shot backfill (most recent inbox threads). */
const BACKFILL_LIMIT = 500;

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
