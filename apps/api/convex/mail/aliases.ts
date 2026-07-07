/**
 * Per-mailbox alias addresses.
 *
 * An alias is a cheap rewrite at the MX layer — `marcel+sales@hl.camp`
 * resolves to the same mailbox as `marcel@hl.camp`, no separate inbox
 * created. The alias is registered in `mailAliases` and pushed to the
 * MTA's Redis cache so `findMailboxRoute()` resolves it without a
 * Convex round-trip per RCPT TO.
 */

import { v } from 'convex/values';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { loadOwnedMailbox } from './permissions';
import {
	throwForbidden,
	throwInvalidInput,
	throwAlreadyExists,
	throwNotFound,
} from '../_utils/errors';

function canonical(addr: string): string {
	return addr.trim().toLowerCase();
}

// public: soft-auth — returns empty for anonymous; mailbox ownership is still enforced in-handler
export const list = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await loadOwnedMailbox(ctx, args.mailboxId);
		if (!owned.ok) return [];
		return ctx.db
			.query('mailAliases')
			.withIndex('by_target', (q) => q.eq('targetMailboxId', args.mailboxId))
			.collect(); // bounded: aliases pointing at one target
	},
});

export const create = authedMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		alias: v.string(),
	},
	handler: async (ctx, args) => {
		const owned = await loadOwnedMailbox(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not accessible');

		const alias = canonical(args.alias);
		if (!alias.includes('@')) throwInvalidInput('Alias must be a full email address');

		// No collision with another mailbox or alias
		const existingMailbox = await ctx.db
			.query('mailboxes')
			.withIndex('by_address', (q) => q.eq('address', alias))
			.first();
		if (existingMailbox) {
			throwAlreadyExists('A mailbox already exists at that address');
		}
		const existingAlias = await ctx.db
			.query('mailAliases')
			.withIndex('by_alias', (q) => q.eq('alias', alias))
			.first();
		if (existingAlias) {
			throwAlreadyExists('Alias already in use');
		}

		const mailbox = await ctx.db.get(args.mailboxId);
		if (!mailbox) throwNotFound('Mailbox');

		const id = await ctx.db.insert('mailAliases', {
			alias,
			targetMailboxId: args.mailboxId,
			organizationId: mailbox.organizationId,
			createdAt: Date.now(),
		});

		// Push to MTA cache so MX resolution is one Redis hop
		await ctx.scheduler.runAfter(0, internal.mail.mailboxActions.pushMailboxToCache, {
			mailboxId: args.mailboxId,
		});
		// Also seed a separate cache entry under the alias address so the
		// resolver doesn't need to know about the indirection.
		await ctx.scheduler.runAfter(0, internal.mail.aliasesActions.pushAliasToCache, {
			alias,
			mailboxId: args.mailboxId,
		});

		return id;
	},
});

export const remove = authedMutation({
	args: { aliasId: v.id('mailAliases') },
	handler: async (ctx, args) => {
		const row = await ctx.db.get(args.aliasId);
		if (!row) return;
		const owned = await loadOwnedMailbox(ctx, row.targetMailboxId);
		if (!owned.ok) throwForbidden('Alias not accessible');
		await ctx.db.delete(args.aliasId);
		await ctx.scheduler.runAfter(0, internal.mail.aliasesActions.removeAliasFromCache, {
			alias: row.alias,
		});
	},
});

