/**
 * Subscriptions panel — list-mail hygiene as one screen instead of a hundred
 * chores.
 *
 * The RFC 8058 One-Click machinery already exists (`mail/unsubscribe.ts`), but
 * only per message, only while that message is open. This module is the
 * aggregate view over the same data plus the batch verb:
 *
 *   - `list` groups the inbox senders whose mail carried a `List-Unsubscribe`
 *     target (`mailMessages.unsubscribe`, parsed once at ingest) with volume,
 *     unread count, and a last-read signal.
 *   - `unsubscribeAndArchive` runs the selected senders through the EXISTING
 *     one-click flow (`api.mail.unsubscribe.performOneClick`) one at a time,
 *     spaced out, and archives what each successful sender still has in the
 *     Inbox. It returns a per-sender outcome so a partial failure reads as
 *     "three done, one needs the sender's web page" rather than a red toast.
 *
 * The scan is a bounded window, not an all-time tally: `SUBSCRIPTION_SCAN_LIMIT`
 * newest inbox messages. A query is a transaction with a read budget, and a
 * message row can carry an inline body, so an unbounded folder walk would be a
 * liability on exactly the mailboxes this feature is for. The returned
 * `truncated` flag lets the UI say which window the numbers describe rather
 * than implying a total.
 */

import { v } from 'convex/values';
import { normalizeEmail } from '@owlat/shared';
import { api, internal } from '../_generated/api';
import { internalMutation } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { authedAction, publicQuery } from '../lib/authedFunctions';
import { requireMailboxAccess } from './permissions';
import { throwForbidden } from '../_utils/errors';
import type { OneClickResult } from './unsubscribe';

/** Newest inbox messages the aggregation reads. See the module note. */
export const SUBSCRIPTION_SCAN_LIMIT = 300;

/** Most senders one batch may act on. Keeps a single action bounded. */
export const SUBSCRIPTION_BATCH_MAX = 25;

/**
 * Gap between two senders' unsubscribe POSTs. Politeness, not throughput: a
 * batch fans out state-changing requests to third-party endpoints, several of
 * which belong to the same ESP, and a burst from one IP is exactly what their
 * abuse heuristics are looking for.
 */
export const SUBSCRIPTION_BATCH_DELAY_MS = 400;

/** Messages from one sender archived per batch entry. */
const ARCHIVE_LIMIT_PER_SENDER = 200;

/** Selected rows `sendersOfMessages` will resolve in one call. */
const SELECTION_RESOLVE_MAX = 200;

/**
 * How a sender can be unsubscribed from, best first.
 *   - `one-click` → RFC 8058 https POST, the only method the batch can perform
 *   - `http`      → a web page the user has to finish by hand
 *   - `mailto`    → an unsubscribe email the composer can prefill
 */
export type SubscriptionMethod = 'one-click' | 'http' | 'mailto';

/** Best-method-first ordering, so a group adopts the strongest it has seen. */
const METHOD_RANK: Record<SubscriptionMethod, number> = { 'one-click': 3, http: 2, mailto: 1 };

export interface SubscriptionMessageInput {
	_id: Id<'mailMessages'>;
	fromAddress: string;
	fromName?: string;
	receivedAt: number;
	flagSeen: boolean;
	unsubscribe?: { httpUrl?: string; mailtoUrl?: string; oneClick: boolean };
}

export interface SubscriptionSender {
	senderEmail: string;
	senderName?: string;
	/** Messages from this sender inside the scanned window. */
	messageCount: number;
	/** How many of those are still unread. */
	unreadCount: number;
	/** Arrival time of the newest message from this sender. */
	lastReceivedAt: number;
	/**
	 * Arrival time of the newest message from this sender that has been READ.
	 * `null` means "nothing from them was ever opened" — the strongest signal
	 * the panel has. It is deliberately the message's arrival time, not a read
	 * timestamp: nothing records when a message was opened, so this answers
	 * "how recent is the newest one you bothered with", which is the question
	 * the column is really asked.
	 */
	lastReadAt: number | null;
	/** Best method available across the window. */
	method: SubscriptionMethod;
	/** Newest message offering `method` — what the batch acts on. */
	actionMessageId: Id<'mailMessages'>;
	/** Target of `method`, so the UI can name the host / open the page. */
	httpUrl?: string;
	mailtoUrl?: string;
}

/** Which method a single message's parsed header supports, if any. */
export function subscriptionMethodOf(
	target: SubscriptionMessageInput['unsubscribe']
): SubscriptionMethod | null {
	if (!target) return null;
	if (target.oneClick && target.httpUrl) return 'one-click';
	if (target.httpUrl) return 'http';
	if (target.mailtoUrl) return 'mailto';
	return null;
}

/**
 * Group list mail by sender. Pure, so the aggregation is unit-testable without
 * a database; the query below is only the bounded read that feeds it.
 *
 * Sorted loudest-first (volume desc), because the panel's job is to surface the
 * senders that cost the most attention; ties break on recency, then address, so
 * the order is stable across re-renders.
 */
export function groupSubscriptionSenders(
	messages: readonly SubscriptionMessageInput[]
): SubscriptionSender[] {
	const groups = new Map<string, SubscriptionSender & { methodAt: number }>();

	for (const message of messages) {
		const method = subscriptionMethodOf(message.unsubscribe);
		if (!method) continue;
		const senderEmail = normalizeEmail(message.fromAddress);
		if (!senderEmail) continue;

		let group = groups.get(senderEmail);
		if (!group) {
			group = {
				senderEmail,
				messageCount: 0,
				unreadCount: 0,
				lastReceivedAt: message.receivedAt,
				lastReadAt: null,
				method,
				methodAt: message.receivedAt,
				actionMessageId: message._id,
			};
			groups.set(senderEmail, group);
		}

		group.messageCount += 1;
		if (!message.flagSeen) group.unreadCount += 1;
		if (message.flagSeen && (group.lastReadAt === null || message.receivedAt > group.lastReadAt)) {
			group.lastReadAt = message.receivedAt;
		}
		// The display name follows the newest message: a sender that rebranded
		// should read under the name it uses now.
		if (message.receivedAt >= group.lastReceivedAt) {
			group.lastReceivedAt = message.receivedAt;
			if (message.fromName) group.senderName = message.fromName;
		}
		// Adopt a strictly better method, or a fresher instance of the same one.
		const better = METHOD_RANK[method] - METHOD_RANK[group.method];
		if (better > 0 || (better === 0 && message.receivedAt >= group.methodAt)) {
			group.method = method;
			group.methodAt = message.receivedAt;
			group.actionMessageId = message._id;
			const target = message.unsubscribe;
			group.httpUrl = target?.httpUrl;
			group.mailtoUrl = target?.mailtoUrl;
		}
	}

	return [...groups.values()]
		.map(({ methodAt: _methodAt, ...sender }) => sender)
		.sort(
			(a, b) =>
				b.messageCount - a.messageCount ||
				b.lastReceivedAt - a.lastReceivedAt ||
				a.senderEmail.localeCompare(b.senderEmail)
		);
}

/**
 * Every list sender in the scanned inbox window, loudest first.
 */
// public: soft-auth — returns an empty panel for anonymous; mailbox access is
// still enforced in-handler via requireMailboxAccess.
export const list = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (
		ctx,
		args
	): Promise<{ senders: SubscriptionSender[]; scanned: number; truncated: boolean }> => {
		const empty = { senders: [] as SubscriptionSender[], scanned: 0, truncated: false };
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return empty;

		const inbox = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('role', 'inbox')
			)
			.first();
		if (!inbox) return empty;

		const rows = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_received', (q) => q.eq('folderId', inbox._id))
			.order('desc')
			.take(SUBSCRIPTION_SCAN_LIMIT);

		return {
			senders: groupSubscriptionSenders(rows),
			scanned: rows.length,
			truncated: rows.length === SUBSCRIPTION_SCAN_LIMIT,
		};
	},
});

/**
 * One sender the batch can finish from a SELECTION, plus the exact message it
 * should POST. The message id travels with the sender because the selection is
 * the authority here: it may name mail in Archive, in Spam, under a label, or
 * older than the panel's inbox window, none of which the `list` snapshot knows
 * about.
 */
export interface SubscriptionSelectionTarget {
	senderEmail: string;
	actionMessageId: Id<'mailMessages'>;
}

/**
 * The distinct One-Click senders behind a message SELECTION — what the list's
 * bulk-actions bar needs to turn "these four rows" into "these two senders"
 * before it offers the Unsubscribe verb (and to hide the verb when the
 * selection holds nothing this verb can finish).
 *
 * Only `one-click` senders come back. The bar's button performs RFC 8058 POSTs
 * and nothing else, so a selection of `http`/`mailto`-only list mail — the
 * common case — must not light it up: the verb would run, attempt nothing, and
 * report "nothing unsubscribed".
 *
 * Messages outside `mailboxId`, and messages with no One-Click target, drop out
 * silently: the caller asked "what can I act on here", not "did every id
 * resolve".
 */
// public: soft-auth — returns empty for anonymous; mailbox access is still
// enforced in-handler via requireMailboxAccess.
export const sendersOfMessages = publicQuery({
	args: { mailboxId: v.id('mailboxes'), messageIds: v.array(v.id('mailMessages')) },
	handler: async (ctx, args): Promise<SubscriptionSelectionTarget[]> => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return [];
		const targets = new Map<string, { actionMessageId: Id<'mailMessages'>; receivedAt: number }>();
		for (const messageId of args.messageIds.slice(0, SELECTION_RESOLVE_MAX)) {
			const message = await ctx.db.get(messageId);
			if (!message || message.mailboxId !== args.mailboxId) continue;
			if (subscriptionMethodOf(message.unsubscribe) !== 'one-click') continue;
			const senderEmail = normalizeEmail(message.fromAddress);
			if (!senderEmail) continue;
			// Newest selected message wins: an unsubscribe token is likelier to
			// still be honoured on the most recent send from that sender.
			const seen = targets.get(senderEmail);
			if (!seen || message.receivedAt > seen.receivedAt) {
				targets.set(senderEmail, { actionMessageId: message._id, receivedAt: message.receivedAt });
			}
		}
		return [...targets.entries()]
			.map(([senderEmail, { actionMessageId }]) => ({ senderEmail, actionMessageId }))
			.sort((a, b) => a.senderEmail.localeCompare(b.senderEmail));
	},
});

/**
 * Archive everything a sender still has in this mailbox's Inbox.
 *
 * Split out as its own mutation because the batch runs from an action, which
 * has no database handle; it is internal because that action is its only
 * caller. Delegates the actual move to `mail.messageActions.move`, which owns
 * UID/modseq allocation and the folder counters — this never re-derives that
 * arithmetic.
 */
// authz: mailbox access via requireMailboxAccess on the caller's propagated
// session; org membership was checked by the calling authedAction. The
// delegated move re-checks access on the target folder.
export const archiveSenderInInbox = internalMutation({
	args: { mailboxId: v.id('mailboxes'), senderEmail: v.string() },
	handler: async (ctx, args): Promise<{ archived: number }> => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not accessible');

		const [inbox, archive] = await Promise.all([
			ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox_and_role', (q) =>
					q.eq('mailboxId', args.mailboxId).eq('role', 'inbox')
				)
				.first(),
			ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox_and_role', (q) =>
					q.eq('mailboxId', args.mailboxId).eq('role', 'archive')
				)
				.first(),
		]);
		// Fail-soft: an unsubscribe that worked must not be reported as failed
		// just because this mailbox has no Archive folder provisioned.
		if (!inbox || !archive) return { archived: 0 };

		const senderEmail = normalizeEmail(args.senderEmail);
		const fromSender = await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_from', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('fromAddress', senderEmail)
			)
			.take(ARCHIVE_LIMIT_PER_SENDER);
		const messageIds = fromSender.filter((m) => m.folderId === inbox._id).map((m) => m._id);
		if (messageIds.length === 0) return { archived: 0 };

		await ctx.runMutation(api.mail.messageActions.move, {
			messageIds,
			targetFolderId: archive._id,
		});
		return { archived: messageIds.length };
	},
});

/**
 * Per-sender outcome of a batch run.
 *   - `unsubscribed`   → the One-Click POST succeeded; `archived` says how much
 *                        of their inbox mail was filed away
 *   - `failed`         → the POST was attempted and did not succeed (`error`
 *                        carries the reason); nothing was archived
 *   - `manual`         → no One-Click target; the user has to finish on the
 *                        sender's page or by mail (`httpUrl` / `mailtoUrl`)
 *   - `not_found`      → the sender has no list mail left in the window
 */
export type SubscriptionBatchOutcome = {
	senderEmail: string;
	status: 'unsubscribed' | 'failed' | 'manual' | 'not_found';
	archived: number;
	error?: string;
	httpUrl?: string;
	mailtoUrl?: string;
};

/**
 * Unsubscribe from, and archive, a batch of senders.
 *
 * Sequenced deliberately: one sender at a time, spaced by
 * `SUBSCRIPTION_BATCH_DELAY_MS`. A fan-out would be faster and would also be a
 * burst of state-changing POSTs at third parties from a single IP.
 *
 * Every sender produces an outcome — the caller renders a summary, and one
 * sender's failure never aborts the rest.
 *
 * `messageIds` is the SELECTION the verb was offered for (the bulk-actions bar
 * path). Those messages are resolved first and win, because they are the rows
 * the user actually ticked: they may sit in Archive, in Spam, under a label, or
 * outside the panel's newest-`SUBSCRIPTION_SCAN_LIMIT` inbox window, and
 * resolving such a sender against the inbox snapshot alone would report
 * `not_found` for mail we are holding the id of. The snapshot is the fallback
 * for anything the selection did not cover — the subscriptions panel sends no
 * ids at all — and is skipped entirely when it would answer nothing.
 */
// authz: mailbox access via requireMailboxAccess (through the list and
// sendersOfMessages queries and the archive mutation, all of which re-check);
// org membership via authedAction.
export const unsubscribeAndArchive = authedAction({
	args: {
		mailboxId: v.id('mailboxes'),
		senderEmails: v.array(v.string()),
		messageIds: v.optional(v.array(v.id('mailMessages'))),
	},
	handler: async (ctx, args): Promise<{ results: SubscriptionBatchOutcome[] }> => {
		// Deduplicate + canonicalize before the cap, so a caller can't smuggle
		// extra work past it with case variants of one address.
		const senders = [...new Set(args.senderEmails.map((email) => normalizeEmail(email)))]
			.filter((email) => email.includes('@'))
			.slice(0, SUBSCRIPTION_BATCH_MAX);

		type BatchTarget = Pick<
			SubscriptionSender,
			'method' | 'actionMessageId' | 'httpUrl' | 'mailtoUrl'
		>;
		const bySender = new Map<string, BatchTarget>();

		if (args.messageIds && args.messageIds.length > 0) {
			const selected: SubscriptionSelectionTarget[] = await ctx.runQuery(
				api.mail.subscriptions.sendersOfMessages,
				{ mailboxId: args.mailboxId, messageIds: args.messageIds }
			);
			for (const target of selected) {
				bySender.set(target.senderEmail, {
					method: 'one-click',
					actionMessageId: target.actionMessageId,
				});
			}
		}

		if (senders.some((senderEmail) => !bySender.has(senderEmail))) {
			const snapshot: { senders: SubscriptionSender[] } = await ctx.runQuery(
				api.mail.subscriptions.list,
				{ mailboxId: args.mailboxId }
			);
			for (const sender of snapshot.senders) {
				if (!bySender.has(sender.senderEmail)) bySender.set(sender.senderEmail, sender);
			}
		}

		const results: SubscriptionBatchOutcome[] = [];
		for (const [index, senderEmail] of senders.entries()) {
			if (index > 0)
				await new Promise((resolve) => setTimeout(resolve, SUBSCRIPTION_BATCH_DELAY_MS));

			const sender = bySender.get(senderEmail);
			if (!sender) {
				results.push({ senderEmail, status: 'not_found', archived: 0 });
				continue;
			}
			if (sender.method !== 'one-click') {
				results.push({
					senderEmail,
					status: 'manual',
					archived: 0,
					...(sender.httpUrl ? { httpUrl: sender.httpUrl } : {}),
					...(sender.mailtoUrl ? { mailtoUrl: sender.mailtoUrl } : {}),
				});
				continue;
			}

			// Reuse the single-message flow verbatim: it owns the SSRF guard, the
			// bounded timeout, and the fail-soft result shape.
			const outcome: OneClickResult = await ctx.runAction(api.mail.unsubscribe.performOneClick, {
				messageId: sender.actionMessageId,
			});
			if (!outcome.ok) {
				results.push({ senderEmail, status: 'failed', archived: 0, error: outcome.error });
				continue;
			}

			const { archived }: { archived: number } = await ctx.runMutation(
				internal.mail.subscriptions.archiveSenderInInbox,
				{ mailboxId: args.mailboxId, senderEmail }
			);
			results.push({ senderEmail, status: 'unsubscribed', archived });
		}

		return { results };
	},
});
