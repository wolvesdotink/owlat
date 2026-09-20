/**
 * Updates — the shared-inbox dashboard of mail that needs no reply.
 *
 * The classify step parks a message in `informational` when the sender is not
 * waiting for an answer (ADR-0061). Nothing is drafted for it; instead it is
 * ranked here so a reader can walk through the important updates in one place,
 * read the one-sentence summary in their own language, and either let it go
 * (`dismissUpdate` → archived) or overrule the classifier and ask for a draft
 * after all (`requestReply` → drafting, through the same resume path an
 * answered clarification takes).
 *
 * Ranking is pure and deterministic (`rankUpdates`): the classifier's
 * importance score first, its priority second, newest first as the tie-break.
 * It never makes a model call, so the dashboard cannot fail-open into hiding
 * something the classifier already decided was important.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { adminMutation, publicQuery } from '../lib/authedFunctions';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { recordAuditLog } from '../lib/auditLog';
import { getOrThrow, throwInvalidState } from '../_utils/errors';
import { isSharedInboxReader } from './access';
import { openConversationThreadPreview } from '../lib/messageBody';
import { BULK_KINDS } from '../agent/steps/draft/sanitize';

/**
 * The dashboard's tabs. `updates` is mail a human wrote that needs no reply;
 * `promotions` and `notifications` are the bulk kinds the classifier files
 * away; `spam` is what it archived as spam (read-only apart from blocking the
 * sender — `archived` is terminal).
 */
export const UPDATE_VIEWS = ['updates', 'promotions', 'notifications', 'spam'] as const;
export type UpdateView = (typeof UPDATE_VIEWS)[number];
export const updateViewValidator = v.union(
	v.literal('updates'),
	v.literal('promotions'),
	v.literal('notifications'),
	v.literal('spam')
);

/** Archive reasons the Spam tab lists. */
const SPAM_ARCHIVE_REASONS: ReadonlySet<string> = new Set(['spam', 'classifier_spam']);

/**
 * Which tab an informational message belongs to, from its classifier kind.
 * Pure + exported for tests. Unknown / missing kind (rows from before the
 * field existed) reads as a plain update so nothing is hidden.
 */
export function updateViewForKind(kind: string | undefined): Exclude<UpdateView, 'spam'> {
	if (kind === 'advertising' || kind === 'newsletter') return 'promotions';
	if (kind === 'notification' || kind === 'receipt') return 'notifications';
	return 'updates';
}

/** True when the classifier's kind marks bulk mail (never expects a reply). */
export function isBulkKind(kind: string | undefined): boolean {
	return kind !== undefined && BULK_KINDS.has(kind);
}

/** Most informational rows the dashboard reads before ranking. */
const MAX_UPDATES = 200;

/** Priority contribution to the rank, below the importance score's weight. */
const PRIORITY_WEIGHT: Readonly<Record<string, number>> = { urgent: 0.3, normal: 0.15, low: 0 };

export interface RankableUpdate {
	receivedAt: number;
	classification?: { importance?: number; priority?: string } | undefined;
}

/** The score one update sorts by. Pure + exported for tests. */
export function updateRankScore(update: RankableUpdate): number {
	const importance = update.classification?.importance ?? 0;
	const priority = PRIORITY_WEIGHT[update.classification?.priority ?? ''] ?? 0;
	return importance + priority;
}

/**
 * Most important first, newest first on a tie. Stable and pure, so the
 * "urgent supplier notice outranks a low-priority newsletter" contract is
 * unit-tested without Convex.
 */
export function rankUpdates<T extends RankableUpdate>(updates: readonly T[]): T[] {
	return [...updates].sort((a, b) => {
		const score = updateRankScore(b) - updateRankScore(a);
		if (score !== 0) return score;
		return b.receivedAt - a.receivedAt;
	});
}

/** The projection the dashboard renders for one update. */
function toUpdateRow(message: Doc<'inboundMessages'>) {
	return {
		_id: message._id,
		threadId: message.threadId,
		contactId: message.contactId,
		from: message.from,
		subject: message.subject,
		receivedAt: message.receivedAt,
		processingStatus: message.processingStatus,
		archiveReason: message.archiveReason,
		classification: message.classification,
	};
}

/**
 * The ranked list of informational mail. Returns [] for non-readers (the
 * shared inbox is admin-only). Bounded: the newest MAX_UPDATES rows are
 * ranked, which is far more than a reader walks through in one sitting.
 */
// public: soft-auth — admin-only shared inbox; returns empty for non-admins
export const listUpdates = publicQuery({
	args: { limit: v.optional(v.number()), view: v.optional(updateViewValidator) },
	handler: async (ctx, args) => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!isSharedInboxReader(session)) return [];

		const limit = Math.min(args.limit ?? 50, MAX_UPDATES);
		const view: UpdateView = args.view ?? 'updates';
		const rows =
			view === 'spam'
				? (
						await ctx.db
							.query('inboundMessages')
							.withIndex('by_processing_status', (q) => q.eq('processingStatus', 'archived'))
							.order('desc')
							.take(MAX_UPDATES)
					).filter(
						(m) => m.archiveReason !== undefined && SPAM_ARCHIVE_REASONS.has(m.archiveReason)
					)
				: (
						await ctx.db
							.query('inboundMessages')
							.withIndex('by_processing_status', (q) => q.eq('processingStatus', 'informational'))
							.order('desc')
							.take(MAX_UPDATES)
					).filter((m) => updateViewForKind(m.classification?.kind) === view);

		const ranked = rankUpdates(rows).slice(0, limit);
		return Promise.all(
			ranked.map(async (message) => {
				const thread = message.threadId ? await ctx.db.get(message.threadId) : null;
				const contact = message.contactId ? await ctx.db.get(message.contactId) : null;
				return {
					message: toUpdateRow(message),
					thread: thread ? await openConversationThreadPreview(thread) : null,
					contact: contact
						? { _id: contact._id, firstName: contact.firstName, lastName: contact.lastName }
						: null,
				};
			})
		);
	},
});

/**
 * Per-tab counts for the dashboard header. Bounded to the same newest window
 * the list reads, so the badge and the list agree.
 */
// public: soft-auth — admin-only shared inbox; returns zeros for non-admins
export const getUpdateCounts = publicQuery({
	args: {},
	handler: async (ctx) => {
		const counts: Record<UpdateView, number> = {
			updates: 0,
			promotions: 0,
			notifications: 0,
			spam: 0,
		};
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!isSharedInboxReader(session)) return counts;
		const informational = await ctx.db
			.query('inboundMessages')
			.withIndex('by_processing_status', (q) => q.eq('processingStatus', 'informational'))
			.order('desc')
			.take(MAX_UPDATES);
		for (const m of informational) counts[updateViewForKind(m.classification?.kind)] += 1;
		const archived = await ctx.db
			.query('inboundMessages')
			.withIndex('by_processing_status', (q) => q.eq('processingStatus', 'archived'))
			.order('desc')
			.take(MAX_UPDATES);
		for (const m of archived) {
			if (m.archiveReason !== undefined && SPAM_ARCHIVE_REASONS.has(m.archiveReason)) {
				counts.spam += 1;
			}
		}
		return counts;
	},
});

/**
 * Let an update go: `informational → archived` (reason `update_dismissed`).
 * Terminal, like every other archive; the thread keeps the message.
 */
export const dismissUpdate = adminMutation({
	args: { inboundMessageId: v.id('inboundMessages') },
	handler: async (ctx, args, session) => {
		const { userId } = session;
		const message = await getOrThrow(ctx, args.inboundMessageId, 'Message');
		if (message.processingStatus !== 'informational') {
			throwInvalidState('Message is not an informational update');
		}
		const outcome = await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: args.inboundMessageId,
			input: { to: 'archived', at: Date.now(), reason: 'update_dismissed', userId },
		});
		if (!outcome.ok) throwInvalidState('Message could not be dismissed');
		await recordAuditLog(ctx, {
			userId,
			action: 'inbound.update_dismissed',
			resource: 'inbound_message',
			resourceId: args.inboundMessageId,
		});
		return { success: true };
	},
});

/**
 * Overrule the classifier: this update does need a reply. Drives
 * `informational → drafting` through the single lifecycle writer and re-enters
 * the draft step via `walker.resumeDraft` (the same path an answered
 * clarification takes — it rebuilds the retrieval context and drafts from the
 * persisted classification, sender language included). The result lands in
 * the review queue; nothing here can auto-send.
 */
export const requestReply = adminMutation({
	args: { inboundMessageId: v.id('inboundMessages') },
	handler: async (ctx, args, session) => {
		const { userId } = session;
		const message = await getOrThrow(ctx, args.inboundMessageId, 'Message');
		if (message.processingStatus !== 'informational') {
			throwInvalidState('Message is not an informational update');
		}
		const now = Date.now();
		const outcome = await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: args.inboundMessageId,
			input: { to: 'drafting', at: now },
		});
		if (!outcome.ok) throwInvalidState('Message could not be sent to drafting');
		await ctx.scheduler.runAfter(0, internal.agent.walker.resumeDraft, {
			inboundMessageId: args.inboundMessageId,
		});
		await recordAuditLog(ctx, {
			userId,
			action: 'inbound.reply_requested',
			resource: 'inbound_message',
			resourceId: args.inboundMessageId,
		});
		return { success: true };
	},
});
