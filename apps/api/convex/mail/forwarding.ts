/**
 * External-forwarding rules — automatically resend inbound mail to an
 * external address (e.g. archive@example.com).
 *
 * Anti-loop guards (see processInboundForwarding):
 *   - skip messages with `Auto-Submitted` header set (RFC 3834)
 *   - skip messages with `List-Id` header (mailing list traffic)
 *   - skip if the X-Owlat-Forwarded chain depth >= 1 (we add the marker
 *     to outgoing forwards so a downstream reply doesn't re-trigger us)
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { requireMailboxAccess } from './permissions';
import { throwForbidden, throwInvalidInput, throwNotFound } from '../_utils/errors';
import { normalizeEmail } from '@owlat/shared';

// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const list = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return [];
		return ctx.db
			.query('mailForwarding')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.collect(); // bounded: one mailbox's forwarding rules
	},
});

export const create = authedMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		forwardTo: v.string(),
		keepLocalCopy: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		// Forwarding reroutes the mailbox's mail off-box — owner-grade routing.
		const owned = await requireMailboxAccess(ctx, args.mailboxId, 'owner');
		if (!owned.ok) throwForbidden('Mailbox not accessible');

		const forwardTo = normalizeEmail(args.forwardTo);
		if (!forwardTo.includes('@')) throwInvalidInput('Invalid forwarding address');

		// Don't forward to ourselves — would loop instantly
		if (owned.mailbox.address === forwardTo) {
			throwInvalidInput('Cannot forward to the same mailbox');
		}

		const now = Date.now();
		return ctx.db.insert('mailForwarding', {
			mailboxId: args.mailboxId,
			forwardTo,
			keepLocalCopy: args.keepLocalCopy ?? true,
			isEnabled: true,
			createdAt: now,
			updatedAt: now,
		});
	},
});

export const update = authedMutation({
	args: {
		id: v.id('mailForwarding'),
		forwardTo: v.optional(v.string()),
		keepLocalCopy: v.optional(v.boolean()),
		isEnabled: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const row = await ctx.db.get(args.id);
		if (!row) throwNotFound('Forwarding rule');
		const owned = await requireMailboxAccess(ctx, row.mailboxId, 'owner');
		if (!owned.ok) throwForbidden('Not accessible');
		const patch: Record<string, unknown> = { updatedAt: Date.now() };
		if (args.forwardTo !== undefined) patch['forwardTo'] = normalizeEmail(args.forwardTo);
		if (args.keepLocalCopy !== undefined) patch['keepLocalCopy'] = args.keepLocalCopy;
		if (args.isEnabled !== undefined) patch['isEnabled'] = args.isEnabled;
		await ctx.db.patch(args.id, patch);
	},
});

export const remove = authedMutation({
	args: { id: v.id('mailForwarding') },
	handler: async (ctx, args) => {
		const row = await ctx.db.get(args.id);
		if (!row) return;
		const owned = await requireMailboxAccess(ctx, row.mailboxId, 'owner');
		if (!owned.ok) throwForbidden('Not accessible');
		await ctx.db.delete(args.id);
	},
});

/** Internal: enabled rules for a mailbox, used by the delivery pipeline. */
export const internalListForMailbox = internalQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query('mailForwarding')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.collect(); // bounded: one mailbox's forwarding rules
		return rows.filter((r) => r.isEnabled);
	},
});
