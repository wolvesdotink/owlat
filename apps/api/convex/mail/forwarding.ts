/**
 * External-forwarding rules — automatically resend inbound mail to an
 * external address (e.g. archive@example.com). The message always stays in
 * the mailbox as well, and rules exist only for mailboxes whose mail Owlat
 * receives itself (`./hostedDeliveryRules`).
 *
 * Anti-loop guards (see processInboundForwarding):
 *   - skip messages with `Auto-Submitted` header set (RFC 3834)
 *   - skip messages with `List-Id` header (mailing list traffic)
 *   - skip if the X-Owlat-Forwarded chain depth >= 1 (we add the marker
 *     to outgoing forwards so a downstream reply doesn't re-trigger us)
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { publicQuery } from '../lib/authedFunctions';
import { postboxMutation } from './_helpers';
import { requireMailboxAccess } from './permissions';
import { getOrThrow, throwForbidden, throwInvalidInput } from '../_utils/errors';
import { normalizeEmail } from '@owlat/shared';
import { assertRunsDeliveryRules } from './hostedDeliveryRules';

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

export const create = postboxMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		forwardTo: v.string(),
		// Ignored: a forwarded message always stays in the mailbox too. A
		// previous-release client still sends it; remove after release N+1.
		keepLocalCopy: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		// Forwarding reroutes the mailbox's mail off-box — owner-grade routing.
		const owned = await requireMailboxAccess(ctx, args.mailboxId, 'owner');
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		assertRunsDeliveryRules(owned.mailbox);

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
			keepLocalCopy: true,
			isEnabled: true,
			createdAt: now,
			updatedAt: now,
		});
	},
});

export const update = postboxMutation({
	args: {
		id: v.id('mailForwarding'),
		forwardTo: v.optional(v.string()),
		// Ignored, as on `create`; remove after release N+1.
		keepLocalCopy: v.optional(v.boolean()),
		isEnabled: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const row = await getOrThrow(ctx, args.id, 'Forwarding rule');
		const owned = await requireMailboxAccess(ctx, row.mailboxId, 'owner');
		if (!owned.ok) throwForbidden('Not accessible');
		// Switching a rule off stays possible, so a stored one can be retired.
		if (args.isEnabled !== false) assertRunsDeliveryRules(owned.mailbox);
		const patch: Record<string, unknown> = { updatedAt: Date.now() };
		if (args.forwardTo !== undefined) patch['forwardTo'] = normalizeEmail(args.forwardTo);
		if (args.isEnabled !== undefined) patch['isEnabled'] = args.isEnabled;
		await ctx.db.patch(args.id, patch);
	},
});

export const remove = postboxMutation({
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
