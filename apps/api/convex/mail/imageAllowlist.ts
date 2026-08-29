/**
 * Per-sender remote-image allowlist for the Postbox reader.
 *
 * The reader blocks remote images by default (`PostboxMessageBody.vue` gates
 * every `<img>` behind an explicit click). That is the right default for an
 * unknown sender and the wrong one for a newsletter someone reads every week:
 * the same button, every issue, forever, which trains people to reach past it
 * for "Load everything" — the escalation that also un-strips tracking pixels.
 *
 * A row here says "load this sender's images on render". It is deliberately the
 * NARROW grant of the two:
 *
 *   - Remote images load automatically for that mailbox + sender pair.
 *   - Tracking-pixel stripping stays ON (`@owlat/shared/postboxTrackers`). The
 *     allowlist never implies it; only the per-message, never-persisted "Load
 *     everything" escalation lifts pixel stripping.
 *   - Nothing else changes: sanitization, the CSP, the sandbox, and link
 *     transparency are untouched.
 *
 * Presence is the entire record — there is no stored "blocked" state — so an
 * absent row is exactly the behaviour the reader had before this existed, and
 * revoking is a plain delete.
 *
 * Scoped to a MAILBOX, not a user: a shared inbox's members see one consistent
 * decision about what that inbox renders, the same shape
 * `mailSenderCategoryOverrides` uses.
 */

import { v } from 'convex/values';
import { normalizeEmail } from '@owlat/shared';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { requireMailboxAccess } from './permissions';
import { throwForbidden, throwInvalidInput } from '../_utils/errors';

/**
 * Defensive cap on the management list. An allowlist is hand-curated, so this
 * is far above any real usage; it exists so the settings query can never turn
 * into an unbounded read.
 */
export const IMAGE_ALLOWLIST_LIMIT = 500;

/**
 * Canonicalize the sender key. `mailMessages.fromAddress` is already stored
 * lowercased by the ingest path (`lib/emailAddress.extractEmail`), so this only
 * has to fold whatever the client sent into the same shape. Rejects anything
 * without an `@` rather than storing a key no message can ever match.
 */
function senderKey(raw: string): string {
	const email = normalizeEmail(raw);
	if (!email.includes('@')) throwInvalidInput('A sender email address is required');
	return email;
}

/**
 * Every sender whose images this mailbox loads automatically, newest grant
 * first (the settings list reads top-down as "what I most recently trusted").
 */
// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const list = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return [];
		const rows = await ctx.db
			.query('mailSenderImageAllowlist')
			.withIndex('by_mailbox_and_sender', (q) => q.eq('mailboxId', args.mailboxId))
			.take(IMAGE_ALLOWLIST_LIMIT);
		return rows
			.map((row) => ({
				_id: row._id,
				senderEmail: row.senderEmail,
				createdAt: row.createdAt,
			}))
			.sort((a, b) => b.createdAt - a.createdAt);
	},
});

/**
 * Grant the sender the always-load-images permission. Idempotent: a second
 * "Always for this sender" click on another message from the same sender keeps
 * the original grant rather than stacking duplicate rows.
 */
// authz: mailbox access via requireMailboxAccess; org membership via authedMutation.
export const allow = authedMutation({
	args: { mailboxId: v.id('mailboxes'), senderEmail: v.string() },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not accessible');

		const senderEmail = senderKey(args.senderEmail);
		const existing = await ctx.db
			.query('mailSenderImageAllowlist')
			.withIndex('by_mailbox_and_sender', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('senderEmail', senderEmail)
			)
			.first();
		if (existing) return existing._id;

		return await ctx.db.insert('mailSenderImageAllowlist', {
			mailboxId: args.mailboxId,
			senderEmail,
			createdAt: Date.now(),
		});
	},
});

/**
 * Revoke by sender address — the shape both call sites have in hand (the
 * reader banner knows the address, not a row id). A no-op when nothing was
 * granted, so a double-click can't fail.
 */
// authz: mailbox access via requireMailboxAccess; org membership via authedMutation.
export const revoke = authedMutation({
	args: { mailboxId: v.id('mailboxes'), senderEmail: v.string() },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not accessible');

		const senderEmail = senderKey(args.senderEmail);
		const existing = await ctx.db
			.query('mailSenderImageAllowlist')
			.withIndex('by_mailbox_and_sender', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('senderEmail', senderEmail)
			)
			.first();
		if (!existing) return { ok: true as const, revoked: false };
		await ctx.db.delete(existing._id);
		return { ok: true as const, revoked: true };
	},
});
