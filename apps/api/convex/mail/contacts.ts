/**
 * Per-mailbox personal address book.
 *
 * Distinct from the org-shared CRM `contacts` table. Auto-populates
 * itself when the user composes/replies (via `recordRecipients`) and
 * is the source for the To/Cc/Bcc autocomplete in the composer.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { loadOwnedMailbox } from './permissions';
import { throwForbidden, throwInvalidInput } from '../_utils/errors';

function canonical(addr: string): string {
	return addr.trim().toLowerCase();
}

// ─── Pure frecency ranking (recency × frequency blend) ───────────────────────
// Exported for unit tests. The autocomplete ordering blends how *recently* a
// contact was corresponded with (a decaying bucket) and how *often* (a bounded
// useCount boost), so a name typed daily outranks one used once long ago.

export interface RankableContact {
	email: string;
	displayName?: string;
	useCount: number;
	lastUsedAt: number;
}

const DAY_MS = 86_400_000;

/** Blended frecency score — higher sorts first. Pure/deterministic given `now`. */
export function contactFrecencyScore(
	contact: Pick<RankableContact, 'useCount' | 'lastUsedAt'>,
	now: number
): number {
	const days = Math.max(0, now - contact.lastUsedAt) / DAY_MS;
	const recency =
		days < 1 ? 100 : days < 7 ? 70 : days < 30 ? 40 : days < 90 ? 20 : 10;
	// Frequency is bounded so a runaway useCount can't drown out recency.
	const frequency = Math.min(50, Math.max(0, contact.useCount) * 5);
	return recency + frequency;
}

type MatchKind = 'emailPrefix' | 'nameStart' | 'nameContains' | 'none';

function matchKind(contact: RankableContact, prefix: string): MatchKind {
	if (contact.email.startsWith(prefix)) return 'emailPrefix';
	const name = (contact.displayName ?? '').toLowerCase();
	if (!name) return 'none';
	if (name.startsWith(prefix)) return 'nameStart';
	if (name.includes(prefix)) return 'nameContains';
	return 'none';
}

const MATCH_RANK: Record<MatchKind, number> = {
	emailPrefix: 3,
	nameStart: 2,
	nameContains: 1,
	none: 0,
};

/**
 * Filter `contacts` to those matching `prefix`, then order by match quality
 * first (an email/name prefix beats a mid-name substring) and frecency second.
 * Returns at most `limit` rows.
 */
export function rankContacts<T extends RankableContact>(
	contacts: readonly T[],
	prefix: string,
	now: number,
	limit: number
): T[] {
	const p = prefix.trim().toLowerCase();
	if (!p) return [];
	return contacts
		.map((c) => ({ c, kind: matchKind(c, p) }))
		.filter((x) => x.kind !== 'none')
		.sort((a, b) => {
			const byMatch = MATCH_RANK[b.kind] - MATCH_RANK[a.kind];
			if (byMatch !== 0) return byMatch;
			const byScore = contactFrecencyScore(b.c, now) - contactFrecencyScore(a.c, now);
			if (byScore !== 0) return byScore;
			return b.c.lastUsedAt - a.c.lastUsedAt;
		})
		.slice(0, limit)
		.map((x) => x.c);
}

// public: soft-auth — returns empty for anonymous; mailbox ownership is still enforced in-handler
export const list = publicQuery({
	args: { mailboxId: v.id('mailboxes'), limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const owned = await loadOwnedMailbox(ctx, args.mailboxId);
		if (!owned.ok) return [];
		const limit = Math.min(args.limit ?? 100, 500);
		return ctx.db
			.query('mailContacts')
			.withIndex('by_mailbox_and_lastUsed', (q) => q.eq('mailboxId', args.mailboxId))
			.order('desc')
			.take(limit);
	},
});

/**
 * Autocomplete query for the recipient field. Returns up to `limit`
 * contacts whose email or display name starts with the prefix, ordered
 * by frecency (lastUsedAt desc).
 */
// public: soft-auth — returns empty for anonymous; mailbox ownership is still enforced in-handler
export const autocomplete = publicQuery({
	args: {
		mailboxId: v.id('mailboxes'),
		prefix: v.string(),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const owned = await loadOwnedMailbox(ctx, args.mailboxId);
		if (!owned.ok) return [];
		const prefix = args.prefix.trim().toLowerCase();
		if (!prefix) return [];
		const limit = Math.min(args.limit ?? 8, 20);

		// Pull recent contacts (Convex doesn't yet have a prefix index for
		// strings; for typical address-book sizes scanning the most-recent
		// 200 is fine).
		const recent = await ctx.db
			.query('mailContacts')
			.withIndex('by_mailbox_and_lastUsed', (q) => q.eq('mailboxId', args.mailboxId))
			.order('desc')
			.take(200);

		// Blend recency + frequency (and match quality) rather than relying on
		// the index order alone, so a frequently-mailed contact isn't buried
		// below a stale one that merely happens to prefix-match.
		return rankContacts(recent, prefix, Date.now(), limit);
	},
});

/**
 * Sender-facing state for the thread reader's VIP star + first-time-sender
 * screener affordance: whether this address is flagged VIP, is a known contact
 * (in the address book), has been waved through the screener, and whether the
 * owner has the screener switched on at all. Drives whether the reader shows an
 * "Accept sender" button. Soft-auth: anonymous / non-owner reads return a safe
 * empty state (no flags, screener off) so nothing renders.
 */
// public: soft-auth — returns empty state for anonymous; mailbox ownership is still enforced in-handler
export const senderState = publicQuery({
	args: { mailboxId: v.id('mailboxes'), email: v.string() },
	handler: async (ctx, args) => {
		const empty = {
			isVip: false,
			isKnown: false,
			isScreenerAccepted: false,
			isScreenerEnabled: false,
		};
		const owned = await loadOwnedMailbox(ctx, args.mailboxId);
		if (!owned.ok) return empty;
		const email = canonical(args.email);
		const settings = await ctx.db
			.query('mailUserSettings')
			.withIndex('by_user', (q) => q.eq('userId', owned.mailbox.userId))
			.first();
		const isScreenerEnabled = settings?.isSenderScreenerOn === true;
		const contact = await ctx.db
			.query('mailContacts')
			.withIndex('by_mailbox_and_email', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('email', email)
			)
			.first();
		if (!contact) return { ...empty, isScreenerEnabled };
		return {
			isVip: contact.isVip === true,
			// A row with real correspondence history is a "known" contact; a bare
			// VIP/accept row (useCount 0) still counts so its VIP star reads right.
			isKnown: true,
			isScreenerAccepted: contact.isScreenerAccepted === true,
			isScreenerEnabled,
		};
	},
});

export const upsert = authedMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		email: v.string(),
		displayName: v.optional(v.string()),
		organization: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const owned = await loadOwnedMailbox(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		const email = canonical(args.email);
		if (!email.includes('@')) throwInvalidInput('Invalid email');

		const now = Date.now();
		const existing = await ctx.db
			.query('mailContacts')
			.withIndex('by_mailbox_and_email', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('email', email)
			)
			.first();
		if (existing) {
			await ctx.db.patch(existing._id, {
				displayName: args.displayName ?? existing.displayName,
				organization: args.organization ?? existing.organization,
				useCount: existing.useCount + 1,
				lastUsedAt: now,
			});
			return existing._id;
		}
		return ctx.db.insert('mailContacts', {
			mailboxId: args.mailboxId,
			email,
			displayName: args.displayName,
			organization: args.organization,
			useCount: 1,
			lastUsedAt: now,
			createdAt: now,
		});
	},
});

export const remove = authedMutation({
	args: { contactId: v.id('mailContacts') },
	handler: async (ctx, args) => {
		const row = await ctx.db.get(args.contactId);
		if (!row) return;
		const owned = await loadOwnedMailbox(ctx, row.mailboxId);
		if (!owned.ok) throwForbidden('Not accessible');
		await ctx.db.delete(args.contactId);
	},
});

/**
 * Toggle the explicit VIP ("important sender") flag on a contact, creating the
 * address-book row if this sender isn't in it yet. A VIP dominates the Reply
 * Queue priority score (mail/priorityScore.ts) — the owner's transparent,
 * easy-to-correct override of the deterministic frecency baseline.
 */
// authz: mailbox ownership via loadOwnedMailbox; org membership via authedMutation.
export const setVip = authedMutation({
	args: { mailboxId: v.id('mailboxes'), email: v.string(), isVip: v.boolean() },
	handler: async (ctx, args) => {
		const owned = await loadOwnedMailbox(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		const email = canonical(args.email);
		if (!email.includes('@')) throwInvalidInput('Invalid email');
		const now = Date.now();
		const existing = await ctx.db
			.query('mailContacts')
			.withIndex('by_mailbox_and_email', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('email', email)
			)
			.first();
		if (existing) {
			await ctx.db.patch(existing._id, { isVip: args.isVip });
			return existing._id;
		}
		// VIP set on someone not yet in the address book — record them so the flag
		// (and future frecency bumps) have a home. useCount 0: they've never been
		// mailed, but the VIP flag short-circuits the score regardless.
		return ctx.db.insert('mailContacts', {
			mailboxId: args.mailboxId,
			email,
			isVip: args.isVip,
			useCount: 0,
			lastUsedAt: now,
			createdAt: now,
		});
	},
});

/**
 * Accept a first-time sender through the HEY-style screener — records them in
 * the address book with `isScreenerAccepted`, so their mail enters the Reply
 * Queue / clarification loop from now on. No-op payload beyond the accept flag;
 * `screener` gating itself is toggled via mail/settings.update.
 */
// authz: mailbox ownership via loadOwnedMailbox; org membership via authedMutation.
export const acceptSender = authedMutation({
	args: { mailboxId: v.id('mailboxes'), email: v.string() },
	handler: async (ctx, args) => {
		const owned = await loadOwnedMailbox(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		const email = canonical(args.email);
		if (!email.includes('@')) throwInvalidInput('Invalid email');
		const now = Date.now();
		const existing = await ctx.db
			.query('mailContacts')
			.withIndex('by_mailbox_and_email', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('email', email)
			)
			.first();
		if (existing) {
			await ctx.db.patch(existing._id, { isScreenerAccepted: true });
			return existing._id;
		}
		return ctx.db.insert('mailContacts', {
			mailboxId: args.mailboxId,
			email,
			isScreenerAccepted: true,
			useCount: 0,
			lastUsedAt: now,
			createdAt: now,
		});
	},
});

/** Internal: bulk-record recipients on send. */
export const internalRecordRecipients = internalMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		emails: v.array(v.string()),
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		for (const raw of args.emails) {
			const email = canonical(raw);
			if (!email.includes('@')) continue;
			const existing = await ctx.db
				.query('mailContacts')
				.withIndex('by_mailbox_and_email', (q) =>
					q.eq('mailboxId', args.mailboxId).eq('email', email)
				)
				.first();
			if (existing) {
				await ctx.db.patch(existing._id, {
					useCount: existing.useCount + 1,
					lastUsedAt: now,
				});
			} else {
				await ctx.db.insert('mailContacts', {
					mailboxId: args.mailboxId,
					email,
					useCount: 1,
					lastUsedAt: now,
					createdAt: now,
				});
			}
		}
	},
});
