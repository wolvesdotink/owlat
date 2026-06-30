'use node';

/**
 * Push alias entries to the MTA mailbox cache so MX resolution stays
 * O(1) Redis lookup. Mirrors the mailMailboxActions pattern.
 */

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { logError, logInfo } from '../lib/runtimeLog';
import { getMtaConfig } from './mtaClient';

export const pushAliasToCache = internalAction({
	args: {
		alias: v.string(),
		mailboxId: v.id('mailboxes'),
	},
	handler: async (ctx, args) => {
		const config = getMtaConfig();
		if (!config) return;

		const mailbox = await ctx.runQuery(internal.mail.mailboxQueries.getById, {
			mailboxId: args.mailboxId,
		});
		if (!mailbox) return;

		const url = `${config.baseUrl}/mailboxes/cache/${encodeURIComponent(args.alias)}`;
		try {
			await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${config.apiKey}`,
				},
				body: JSON.stringify({
					mailboxId: mailbox._id,
					organizationId: mailbox.organizationId,
					quotaBytes: mailbox.quotaBytes,
					usedBytes: mailbox.usedBytes,
				}),
			});
			logInfo(`[Alias cache] Pushed ${args.alias} -> ${mailbox.address}`);
		} catch (err) {
			logError('[Alias cache] Push error:', err);
		}
	},
});

export const removeAliasFromCache = internalAction({
	args: { alias: v.string() },
	handler: async (_ctx, args) => {
		const config = getMtaConfig();
		if (!config) return;
		const url = `${config.baseUrl}/mailboxes/cache/${encodeURIComponent(args.alias)}`;
		try {
			await fetch(url, {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${config.apiKey}` },
			});
		} catch (err) {
			logError('[Alias cache] Removal error:', err);
		}
	},
});
