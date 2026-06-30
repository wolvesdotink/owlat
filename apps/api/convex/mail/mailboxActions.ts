'use node';

/**
 * Push mailbox CRUD events to the MTA's mailbox cache.
 *
 * Called from the mailMailbox mutations (via ctx.scheduler.runAfter) so
 * the MTA's onRcptTo lookup stays warm for newly-created mailboxes.
 */

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { logError, logInfo } from '../lib/runtimeLog';
import { getMtaConfig } from './mtaClient';

export const pushMailboxToCache = internalAction({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const config = getMtaConfig();
		if (!config) {
			logError('[Mailbox cache] MTA_API_URL/MTA_API_KEY not set; skipping push');
			return;
		}

		const mailbox = await ctx.runQuery(internal.mail.mailboxQueries.getById, {
			mailboxId: args.mailboxId,
		});
		if (!mailbox) return;

		const url = `${config.baseUrl}/mailboxes/cache/${encodeURIComponent(mailbox.address)}`;
		try {
			const res = await fetch(url, {
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
			if (!res.ok) {
				const body = await res.text().catch(() => '');
				logError(`[Mailbox cache] Push failed (${res.status}): ${body}`);
				return;
			}
			logInfo(`[Mailbox cache] Pushed ${mailbox.address}`);
		} catch (err) {
			logError('[Mailbox cache] Push error:', err);
		}
	},
});

export const removeFromCache = internalAction({
	args: { address: v.string() },
	handler: async (_ctx, args) => {
		const config = getMtaConfig();
		if (!config) return;

		const url = `${config.baseUrl}/mailboxes/cache/${encodeURIComponent(args.address)}`;
		try {
			await fetch(url, {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${config.apiKey}` },
			});
			logInfo(`[Mailbox cache] Removed ${args.address}`);
		} catch (err) {
			logError('[Mailbox cache] Removal error:', err);
		}
	},
});
