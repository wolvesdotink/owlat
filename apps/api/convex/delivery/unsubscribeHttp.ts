/**
 * Unsubscribe HTTP endpoints — RFC 8058 one-click POST and the verify GET.
 *
 * Both are public, token-keyed `httpAction`s wrapped by the **Public token
 * endpoint (module)**: the shell owns CORS, rate-limit, token extract, body
 * parse, and response envelope; the handlers below just decide what each
 * specific token does.
 *
 * See docs/adr/0030-public-token-endpoint-module.md.
 */

import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { publicTokenEndpoint } from '../lib/publicTokenEndpoint';
import type { TokenValidation } from './tokenValidation';
import { logWarn } from '../lib/runtimeLog';

interface ContactUnsubInfo {
	email: string;
	firstName?: string;
	subscribed: boolean;
	organizationName: string;
}

interface ProcessOutcome {
	success: boolean;
	alreadyUnsubscribed?: boolean;
	listsRemoved?: number;
}

/**
 * RFC 8058 one-click unsubscribe — POST /unsub/{token}.
 *
 * No CORS — this is a server-to-server POST initiated by the mail client.
 */
export const handleOneClickUnsubscribe = publicTokenEndpoint(
	{
		path: '/unsub/:token',
		method: 'POST',
		rateLimit: 'subscriptionManagement',
		rateLimitKeyMode: 'ip+token',
		cors: false,
		resultMode: 'action',
	},
	async (ctx, { token }) => {
		const startedAt = Date.now();
		const validation = await ctx.runAction<TokenValidation>(
			internal.delivery.unsubscribe.validateToken,
			{ token }
		);

		if (!validation.valid) {
			return {
				ok: false,
				reason: validation.reason ?? 'invalid_token',
				message: 'Invalid or expired unsubscribe link',
				status: 400,
			};
		}

		const result = await ctx.runMutation<ProcessOutcome>(
			internal.delivery.unsubscribeQueries.processUnsubscribe,
			{ contactId: validation.contactId as Id<'contacts'> }
		);

		if (!result.success) {
			return {
				ok: false,
				reason: 'contact_not_found',
				message: 'Contact not found',
				status: 404,
			};
		}

		const listsRemoved = result.alreadyUnsubscribed ? 0 : (result.listsRemoved ?? 0);
		const message = result.alreadyUnsubscribed
			? 'You were already unsubscribed from all topics'
			: `You have been successfully unsubscribed from ${listsRemoved} topic${listsRemoved === 1 ? '' : 's'}`;

		// Only successful/idempotent valid unsubscribe operations belong in this
		// business-latency metric. Invalid public traffic must not dilute its p95.
		const recordedAt = Date.now();
		try {
			await ctx.runMutation(internal.delivery.complianceTelemetry.recordUnsubscribeLatency, {
				durationMs: recordedAt - startedAt,
				recordedAt,
			});
		} catch (error) {
			// Telemetry must never turn a successfully-applied unsubscribe into a
			// provider-visible error that might trigger a retry.
			logWarn('[unsubscribe] failed to record processing latency:', error);
		}

		return { ok: true, data: { message, listsRemoved } };
	}
);

/**
 * Verify unsubscribe token — GET /unsub/verify/{token}.
 *
 * Outcome mode: a verification that finds an expired token returns HTTP 200
 * with `{ ok: false, reason }`. The frontend renders a friendly "this link
 * expired" page rather than treating the verification request itself as a
 * protocol error.
 */
export const verifyUnsubscribeToken = publicTokenEndpoint(
	{
		path: '/unsub/verify/:token',
		method: 'GET',
		rateLimit: 'subscriptionManagement',
		rateLimitKeyMode: 'ip+token',
		cors: 'GET, OPTIONS',
		resultMode: 'outcome',
	},
	async (ctx, { token }) => {
		const validation = await ctx.runAction<TokenValidation>(
			internal.delivery.unsubscribe.validateToken,
			{ token }
		);

		if (!validation.valid) {
			return { ok: false, reason: validation.reason ?? 'invalid_token' };
		}

		const contact = await ctx.runQuery<ContactUnsubInfo | null>(
			internal.delivery.unsubscribeQueries.getContactForUnsubscribe,
			{ contactId: validation.contactId as Id<'contacts'> }
		);

		if (!contact) {
			return { ok: false, reason: 'contact_not_found' };
		}

		return {
			ok: true,
			data: {
				email: contact.email,
				firstName: contact.firstName,
				subscribed: contact.subscribed,
				organizationName: contact.organizationName,
			},
		};
	}
);
