/**
 * Daily Brief card — the per-owner cache behind the small greeting card at the
 * top of the Postbox Today view (PostboxDailyBrief.vue).
 *
 * Mirrors the thread-summary cache architecture (mail/summaryCache.ts):
 * a small persisted cache row (`mailBriefCards`), a reactive read the card
 * subscribes to that serves the cache instantly, and a separate regeneration
 * entry point the client triggers in the background when the read flags the
 * cache stale (stale-while-revalidate). Two deliberate differences:
 *
 *   - The card is assembled from COUNTS the client templates into sentences —
 *     new inbox mail since the viewer's local midnight, reply drafts the agent
 *     prepared overnight, low-signal mail it auto-filed, and the open
 *     clarification questions blocked on the owner. All of it comes from data
 *     other features already persist (mailMessages, needsReply flags, category
 *     labels), so regeneration is a deterministic MUTATION — no LLM call path,
 *     no 'use node' action half.
 *   - Freshness is calendar-based: regenerate at most once per viewer-local
 *     morning, or early when >= NEW_MAIL_STALE_THRESHOLD messages arrived
 *     since the cached card was generated.
 *
 * Everything is advisory + fail-soft: no session / no access / no cache simply
 * means no card (the Today view renders without it — never an error card).
 * The viewer's local day + midnight are client-supplied (the server has no
 * timezone); they only ever shape the caller's own card, so they are not a
 * trust boundary.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { loadOwnedMailbox } from './permissions';
import { isBundledCategory } from './dailyBrief';

// ─── Freshness rules (pure, unit-tested) ─────────────────────────────────────

/** New inbound messages since the cached card that force an early refresh. */
export const NEW_MAIL_STALE_THRESHOLD = 5;

/**
 * The overnight window the agent-activity counts (drafted / auto-filed) look
 * back over: from 12h before the viewer's local midnight (i.e. yesterday
 * evening) up to now. Chosen so "overnight" copy stays honest for the usual
 * morning open without tracking per-user working hours.
 */
export const OVERNIGHT_LOOKBACK_MS = 12 * 60 * 60 * 1000;

export interface BriefCardFreshnessInput {
	/** The cached card's local day, or null when no card exists yet. */
	cachedLocalDay: string | null;
	/** The viewer's current local day (YYYY-MM-DD). */
	localDay: string;
	/** Inbound messages that arrived after the cached card was generated. */
	newSinceGenerated: number;
}

/**
 * "Should the card regenerate?" — the whole freshness policy in one pure
 * predicate: no card yet, a new local morning, or an early refresh once
 * NEW_MAIL_STALE_THRESHOLD messages arrived since generation. Anything else
 * serves the cache untouched ("at most once per local morning").
 */
export function isBriefCardStale(input: BriefCardFreshnessInput): boolean {
	if (input.cachedLocalDay === null) return true;
	if (input.cachedLocalDay !== input.localDay) return true;
	return input.newSinceGenerated >= NEW_MAIL_STALE_THRESHOLD;
}

// ─── Count gathering (bounded reads) ─────────────────────────────────────────

/** Bound on counted new messages — the card says "99" past this, never scans on. */
const MAX_COUNTED_MESSAGES = 99;
/** Bound on scanned needs-reply / recent threads per regeneration. */
const THREAD_SCAN_LIMIT = 200;

export interface BriefCardCounts {
	newMail: number;
	drafted: number;
	questions: number;
	autoFiled: number;
}

async function countNewMessagesSince(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	sinceTs: number,
	limit: number
): Promise<number> {
	const rows = await ctx.db
		.query('mailMessages')
		.withIndex('by_mailbox_and_received', (q) =>
			q.eq('mailboxId', mailboxId).gt('receivedAt', sinceTs)
		)
		.take(limit);
	return rows.length;
}

/**
 * Gather the card's counts from data other features already persist — the same
 * sources the Reply Queue and smart-inbox surfaces read, so every number on
 * the card is a link the owner can follow to the real rows.
 */
async function gatherBriefCounts(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	dayStartTs: number
): Promise<BriefCardCounts> {
	const overnightStart = dayStartTs - OVERNIGHT_LOOKBACK_MS;

	// New mail: inbound messages since the viewer's local midnight.
	const newMail = await countNewMessagesSince(ctx, mailboxId, dayStartTs, MAX_COUNTED_MESSAGES);

	// Agent activity + open questions, from the same needsReply flags the Reply
	// Queue lists. Drafted counts only slots generated in the overnight window;
	// questions count every clarification still awaiting an answer (blocked on
	// the owner is a NOW state, not a window).
	let drafted = 0;
	let questions = 0;
	const needsReplyThreads = await ctx.db
		.query('mailThreads')
		.withIndex('by_mailbox_needs_reply', (q) =>
			q.eq('mailboxId', mailboxId).gt('needsReply.detectedAt', 0)
		)
		.order('desc')
		.take(THREAD_SCAN_LIMIT);
	for (const thread of needsReplyThreads) {
		const flag = thread.needsReply;
		if (!flag) continue;
		if (flag.draftSlot && flag.draftSlot.generatedAt >= overnightStart) drafted += 1;
		if (flag.clarification?.isNeeded === true) questions += 1;
	}

	// Auto-filed: low-signal inbox threads (newsletter/notification/receipt —
	// the same categories the smart inbox folds away) active in the window.
	let autoFiled = 0;
	const recentThreads = await ctx.db
		.query('mailThreads')
		.withIndex('by_mailbox_and_last_message', (q) =>
			q.eq('mailboxId', mailboxId).gt('lastMessageAt', overnightStart)
		)
		.order('desc')
		.take(THREAD_SCAN_LIMIT);
	for (const thread of recentThreads) {
		const cat = thread.category?.label;
		if (cat !== undefined && isBundledCategory(cat) && thread.folderRoles.includes('inbox')) {
			autoFiled += 1;
		}
	}

	return { newMail, drafted, questions, autoFiled };
}

// ─── Read side (stale-while-revalidate) ──────────────────────────────────────

async function loadCard(
	ctx: { db: QueryCtx['db'] },
	mailboxId: Id<'mailboxes'>,
	userId: string
): Promise<Doc<'mailBriefCards'> | null> {
	return await ctx.db
		.query('mailBriefCards')
		.withIndex('by_mailbox_and_user', (q) => q.eq('mailboxId', mailboxId).eq('userId', userId))
		// `.first()` (not `.unique()`): the upsert keeps this 1-per-(mailbox,user),
		// but a duplicate from a write race must degrade, never throw (fail-soft).
		.first();
}

/**
 * The cached Daily Brief card + its freshness. Serves whatever is cached
 * INSTANTLY (even from a previous day — stale-while-revalidate); `isStale`
 * tells the client to trigger a background `refresh`. Fail-soft: null for
 * anonymous / non-owner / inactive mailbox — the card simply doesn't render.
 */
// public: soft-auth — returns null for anonymous; mailbox ownership is enforced
// in-handler via loadOwnedMailbox (null for a non-owner).
export const getBriefCard = publicQuery({
	args: {
		mailboxId: v.id('mailboxes'),
		// Viewer-local calendar day (YYYY-MM-DD); shapes only the caller's card.
		localDay: v.string(),
	},
	handler: async (ctx, args) => {
		const access = await loadOwnedMailbox(ctx, args.mailboxId);
		if (!access.ok) return null;
		const card = await loadCard(ctx, args.mailboxId, access.userId);
		if (!card) return { card: null, isStale: true, isDismissed: false };
		const newSinceGenerated = await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_received', (q) =>
				q.eq('mailboxId', args.mailboxId).gt('receivedAt', card.generatedAt)
			)
			.take(NEW_MAIL_STALE_THRESHOLD);
		return {
			card: {
				localDay: card.localDay,
				generatedAt: card.generatedAt,
				counts: card.counts,
			},
			isStale: isBriefCardStale({
				cachedLocalDay: card.localDay,
				localDay: args.localDay,
				newSinceGenerated: newSinceGenerated.length,
			}),
			isDismissed: card.dismissedDay === args.localDay,
		};
	},
});

// ─── Regeneration + dismissal ────────────────────────────────────────────────

/**
 * Regenerate the caller's brief card when (and only when) the freshness policy
 * says so — idempotent otherwise, so the client's background revalidation can
 * never loop the write. Deterministic template data only (counts from existing
 * rows); a mutation rather than an action because there is no LLM step.
 */
// authz: per-user mailbox ownership via loadOwnedMailbox; writes only the
// caller's own card row.
export const refresh = authedMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		// Viewer-local calendar day (YYYY-MM-DD) + its local-midnight timestamp.
		localDay: v.string(),
		dayStartTs: v.number(),
	},
	handler: async (ctx, args) => {
		const access = await loadOwnedMailbox(ctx, args.mailboxId);
		// Fail-soft (never an error card): no access simply means no brief.
		if (!access.ok) return null;

		const existing = await loadCard(ctx, args.mailboxId, access.userId);
		if (existing) {
			const newSinceGenerated = await ctx.db
				.query('mailMessages')
				.withIndex('by_mailbox_and_received', (q) =>
					q.eq('mailboxId', args.mailboxId).gt('receivedAt', existing.generatedAt)
				)
				.take(NEW_MAIL_STALE_THRESHOLD);
			const isStale = isBriefCardStale({
				cachedLocalDay: existing.localDay,
				localDay: args.localDay,
				newSinceGenerated: newSinceGenerated.length,
			});
			// "At most once per local morning": a fresh card is served untouched.
			if (!isStale) {
				return { localDay: existing.localDay, generatedAt: existing.generatedAt };
			}
		}

		const now = Date.now();
		const counts = await gatherBriefCounts(ctx, args.mailboxId, args.dayStartTs);
		if (existing) {
			await ctx.db.patch(existing._id, {
				localDay: args.localDay,
				generatedAt: now,
				counts,
				// A new generation belongs to a new (or busier) morning — any
				// dismissal from a previous day no longer applies. Same-day early
				// refreshes keep a same-day dismissal.
				dismissedDay: existing.dismissedDay === args.localDay ? existing.dismissedDay : undefined,
				updatedAt: now,
			});
		} else {
			await ctx.db.insert('mailBriefCards', {
				mailboxId: args.mailboxId,
				userId: access.userId,
				localDay: args.localDay,
				generatedAt: now,
				counts,
				createdAt: now,
				updatedAt: now,
			});
		}
		return { localDay: args.localDay, generatedAt: now };
	},
});

/**
 * Dismiss (x) the card for the rest of the viewer's local day — it returns
 * with the next morning's regeneration. Persisted next to the cache so the
 * dismissal follows the owner across devices.
 */
// authz: per-user mailbox ownership via loadOwnedMailbox; writes only the
// caller's own card row.
export const dismiss = authedMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		// The viewer-local day being dismissed (YYYY-MM-DD).
		localDay: v.string(),
	},
	handler: async (ctx, args) => {
		const access = await loadOwnedMailbox(ctx, args.mailboxId);
		if (!access.ok) return null;
		const card = await loadCard(ctx, args.mailboxId, access.userId);
		// Nothing rendered means nothing to dismiss — a silent no-op.
		if (!card) return null;
		await ctx.db.patch(card._id, { dismissedDay: args.localDay, updatedAt: Date.now() });
		return null;
	},
});
