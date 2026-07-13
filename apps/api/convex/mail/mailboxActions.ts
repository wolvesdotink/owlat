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
import { isDevDeployment } from '../devShortcuts/_guard';

export const pushMailboxToCache = internalAction({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const config = getMtaConfig();
		if (!config) {
			// Expected on dev deployments (no local MTA — hosted mailboxes just
			// skip the cache warm-up); a real misconfiguration anywhere else,
			// where the MTA's onRcptTo lookup depends on this push.
			if (!isDevDeployment()) {
				logError('[Mailbox cache] MTA_API_URL/MTA_API_KEY not set; skipping push');
			}
			return;
		}

		const mailbox = await ctx.runQuery(internal.mail.mailboxQueries.getById, {
			mailboxId: args.mailboxId,
		});
		if (!mailbox) return;
		const isInboundTlsRequired = await ctx.runQuery(
			internal.workspaces.settings.getInboundTlsPolicy,
			{}
		);

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
					isInboundTlsRequired,
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

/** Push an owner/admin policy change into the MTA's Redis-backed SMTP gate. */
export const pushInboundTlsPolicy = internalAction({
	args: {},
	handler: async (ctx) => {
		const config = getMtaConfig();
		if (!config) return;
		const isRequired = await ctx.runQuery(internal.workspaces.settings.getInboundTlsPolicy, {});
		try {
			const res = await fetch(`${config.baseUrl}/mailboxes/inbound-tls-policy`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${config.apiKey}`,
				},
				body: JSON.stringify({ isRequired }),
			});
			if (!res.ok) {
				const body = await res.text().catch(() => '');
				logError(`[Inbound TLS policy] Push failed (${res.status}): ${body}`);
				return;
			}
			logInfo(`[Inbound TLS policy] Pushed ${isRequired ? 'required' : 'optional'}`);
		} catch (err) {
			logError('[Inbound TLS policy] Push error:', err);
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
