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

		return recent
			.filter(
				(c) =>
					c.email.startsWith(prefix) ||
					(c.displayName ?? '').toLowerCase().includes(prefix)
			)
			.slice(0, limit);
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
