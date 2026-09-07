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
import { requireMailboxAccess } from './permissions';
import { throwForbidden, throwInvalidInput } from '../_utils/errors';
import { normalizeEmail } from '@owlat/shared';
import { DAY_MS } from '../lib/constants';

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

/** Blended frecency score — higher sorts first. Pure/deterministic given `now`. */
export function contactFrecencyScore(
	contact: Pick<RankableContact, 'useCount' | 'lastUsedAt'>,
	now: number
): number {
	const days = Math.max(0, now - contact.lastUsedAt) / DAY_MS;
	const recency = days < 1 ? 100 : days < 7 ? 70 : days < 30 ? 40 : days < 90 ? 20 : 10;
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

// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const list = publicQuery({
	args: { mailboxId: v.id('mailboxes'), limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
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
// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const autocomplete = publicQuery({
	args: {
		mailboxId: v.id('mailboxes'),
		prefix: v.string(),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
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
// public: soft-auth — returns empty state for anonymous; mailbox access is still enforced in-handler
export const senderState = publicQuery({
	args: { mailboxId: v.id('mailboxes'), email: v.string() },
	handler: async (ctx, args) => {
		const empty = {
			isVip: false,
			isKnown: false,
			isScreenerAccepted: false,
			isScreenerEnabled: false,
		};
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return empty;
		const email = normalizeEmail(args.email);
		// The screener toggle is a per-user preference, so read it for the CALLER
		// (`owned.userId`), not the mailbox owner (`owned.mailbox.userId`): on a
		// shared mailbox a delegate previously saw the owner's screener state
		// instead of their own. On a personal mailbox the two ids coincide.
		const settings = await ctx.db
			.query('mailUserSettings')
			.withIndex('by_user', (q) => q.eq('userId', owned.userId))
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

/**
 * How many recipients one composer draft may ask about at a time. Each answer
 * is a single indexed lookup, and a draft with more than this many recipients
 * is a mailing list — the first-time cue is not what it needs.
 */
const KNOWN_RECIPIENT_LIMIT = 50;

/**
 * Which of `emails` this mailbox already has an address-book row for.
 *
 * The composer's counterpart to the reader's `senderState`: it marks the
 * recipients you have NEVER written to (or heard from), so an autocomplete
 * mis-pick is visible before the send rather than after it. A row exists once
 * `internalRecordRecipients` has seen the address on a send, or once the owner
 * VIP'd / accepted the sender — all of which mean "not a stranger".
 *
 * Returns the KNOWN subset rather than the unknown one on purpose: the caller
 * must not treat a pending or refused answer as "everyone is a stranger", which
 * would brand every recipient first-time.
 */
// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const knownRecipients = publicQuery({
	args: { mailboxId: v.id('mailboxes'), emails: v.array(v.string()) },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return [];
		const wanted = [
			...new Set(args.emails.map((raw) => normalizeEmail(raw)).filter((e) => e.includes('@'))),
		].slice(0, KNOWN_RECIPIENT_LIMIT);
		const known: string[] = [];
		for (const email of wanted) {
			const contact = await ctx.db
				.query('mailContacts')
				.withIndex('by_mailbox_and_email', (q) =>
					q.eq('mailboxId', args.mailboxId).eq('email', email)
				)
				.first();
			if (contact) known.push(email);
		}
		return known;
	},
});

/**
 * The IANA timezone the org's CRM has on record for each of `emails`, for the
 * recipients it has one for (plan idea 9).
 *
 * Feeds the schedule dialog's dual-clock presets: "tomorrow 9:00" means very
 * different things when you are in San Francisco and they are in Berlin, and
 * the answer is only worth showing when it is actually KNOWN. `contacts
 * .timezone` is set explicitly (import, CRM edit, API), so it is a fact about
 * the recipient rather than a guess — the dialog degrades silently to
 * sender-clock presets for everyone it gets no answer about.
 *
 * Returns only the addresses WITH a timezone, so a pending or refused read can
 * never be mistaken for "nobody has one" in a way that invents a wrong clock.
 * Soft-deleted contacts are skipped. Single-org deployment, so the mailbox
 * guard is the whole authorization story (same shape as `knownRecipients`).
 */
// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
// token-safe: projects each contact to { address, timeZone } — the row itself never leaves
export const recipientTimeZones = publicQuery({
	args: { mailboxId: v.id('mailboxes'), emails: v.array(v.string()) },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return [];
		const wanted = [
			...new Set(args.emails.map((raw) => normalizeEmail(raw)).filter((e) => e.includes('@'))),
		].slice(0, KNOWN_RECIPIENT_LIMIT);
		const found: Array<{ address: string; timeZone: string }> = [];
		for (const email of wanted) {
			const contact = await ctx.db
				.query('contacts')
				.withIndex('by_email', (q) => q.eq('email', email))
				.first();
			if (!contact || contact.deletedAt !== undefined) continue;
			const timeZone = contact.timezone?.trim();
			if (timeZone) found.push({ address: email, timeZone });
		}
		return found;
	},
});

/** Recency window scanned for correspondent domains — the autocomplete's own. */
const DOMAIN_SCAN_LIMIT = 200;
/** Distinct domains handed to the client; more than this is not a typo corpus. */
const DOMAIN_RESULT_LIMIT = 40;

/**
 * The domains this mailbox actually writes to, most recently used first.
 *
 * Feeds the composer's did-you-mean hint: `@northwind.studio` matters far more
 * to this user than any global provider list, so a near-miss of a domain in
 * here is the strongest typo signal available. Deliberately takes no recipient
 * argument, so the subscription is stable per mailbox while chips come and go.
 */
// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const correspondentDomains = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return [];
		const recent = await ctx.db
			.query('mailContacts')
			.withIndex('by_mailbox_and_lastUsed', (q) => q.eq('mailboxId', args.mailboxId))
			.order('desc')
			.take(DOMAIN_SCAN_LIMIT);
		const domains = new Set<string>();
		for (const contact of recent) {
			const at = contact.email.lastIndexOf('@');
			const domain = at > 0 ? contact.email.slice(at + 1).toLowerCase() : '';
			if (domain.includes('.')) domains.add(domain);
			if (domains.size >= DOMAIN_RESULT_LIMIT) break;
		}
		return [...domains];
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
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		const email = normalizeEmail(args.email);
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
		const owned = await requireMailboxAccess(ctx, row.mailboxId);
		if (!owned.ok) throwForbidden('Not accessible');
		await ctx.db.delete(args.contactId);
	},
});

/**
 * Toggle the explicit VIP ("important sender") flag on a contact, creating the
 * address-book row if this sender isn't in it yet. A VIP dominates the Reply
 * Queue priority score (mail/ai/priorityScore.ts) — the owner's transparent,
 * easy-to-correct override of the deterministic frecency baseline.
 */
// authz: mailbox access via requireMailboxAccess; org membership via authedMutation.
export const setVip = authedMutation({
	args: { mailboxId: v.id('mailboxes'), email: v.string(), isVip: v.boolean() },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		const email = normalizeEmail(args.email);
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
// authz: mailbox access via requireMailboxAccess; org membership via authedMutation.
export const acceptSender = authedMutation({
	args: { mailboxId: v.id('mailboxes'), email: v.string() },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		const email = normalizeEmail(args.email);
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
			const email = normalizeEmail(raw);
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
