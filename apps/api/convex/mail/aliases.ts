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
import { requireMailboxAccess } from './permissions';
import {
	getOrThrow,
	throwForbidden,
	throwInvalidInput,
	throwAlreadyExists,
} from '../_utils/errors';
import { isFeatureEnabled } from '../lib/featureFlags';
import { normalizeEmail } from '@owlat/shared';

// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const list = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
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
		// Aliases change MTA routing and expand the send-as allow-list
		// (resolveAllowedFromAddresses), so creating one is owner-grade.
		const owned = await requireMailboxAccess(ctx, args.mailboxId, 'owner');
		if (!owned.ok) throwForbidden('Mailbox not accessible');

		const alias = normalizeEmail(args.alias);
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

		const mailbox = await getOrThrow(ctx, args.mailboxId, 'Mailbox');

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

		// Sealed Mail (E1): mint + publish an E2EE keypair for the new alias
		// address (flag-gated `sealedMail`, default OFF; no-op when off).
		if (await isFeatureEnabled(ctx, 'sealedMail')) {
			await ctx.scheduler.runAfter(0, internal.e2ee.keysNode.mintForAddress, { address: alias });
		}

		return id;
	},
});

export const remove = authedMutation({
	args: { aliasId: v.id('mailAliases') },
	handler: async (ctx, args) => {
		const row = await ctx.db.get(args.aliasId);
		if (!row) return;
		// Removing an alias changes MTA routing / the send-as set — owner-grade.
		const owned = await requireMailboxAccess(ctx, row.targetMailboxId, 'owner');
		if (!owned.ok) throwForbidden('Alias not accessible');
		await ctx.db.delete(args.aliasId);
		await ctx.scheduler.runAfter(0, internal.mail.aliasesActions.removeAliasFromCache, {
			alias: row.alias,
		});
	},
});
