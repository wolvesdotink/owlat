/**
 * DOI confirmation HTTP endpoints — verify token (GET) and confirm (POST).
 * Both wrap their domain mutation/query in the **Public token endpoint
 * (module)** shell; the token sits in `?token=` rather than a URL segment
 * here, which the shell handles via the matcher's `?token=` fallback.
 *
 * See docs/adr/0030-public-token-endpoint-module.md.
 */

import { internal } from '../_generated/api';
import { publicTokenEndpoint } from '../lib/publicTokenEndpoint';

type DoiStatus = 'not_required' | 'pending' | 'confirmed';

interface ContactByDoi {
	contactEmail: string;
	contactFirstName?: string;
	doiStatus: DoiStatus;
}

interface ConfirmDoiResult {
	success: boolean;
	alreadyConfirmed?: boolean;
	contactEmail?: string;
	error?: string;
}

/**
 * Verify contact DOI token — GET /confirm/doi/verify?token={token}.
 *
 * Action mode (not outcome): missing-or-expired tokens currently return a
 * 404 with the locked envelope, which matches today's behaviour and the
 * other DOI sites.
 */
export const verifyContactDoiToken = publicTokenEndpoint(
	{
		path: '/confirm/doi/verify',
		method: 'GET',
		rateLimit: 'doiConfirmation',
		rateLimitKeyMode: 'ip+token',
		cors: 'GET, POST, OPTIONS',
		resultMode: 'action',
	},
	async (ctx, { token }) => {
		const contact = await ctx.runQuery<ContactByDoi | null>(
			internal.topics.topics.getContactByDoiToken,
			{ token },
		);

		if (!contact) {
			return {
				ok: false,
				reason: 'invalid_token',
				message: 'Invalid or expired confirmation token',
				status: 404,
			};
		}

		if (contact.doiStatus === 'confirmed') {
			return {
				ok: true,
				data: {
					alreadyConfirmed: true,
					contactEmail: contact.contactEmail,
				},
			};
		}

		return {
			ok: true,
			data: {
				contactEmail: contact.contactEmail,
				contactFirstName: contact.contactFirstName,
				doiStatus: contact.doiStatus,
			},
		};
	},
);

/**
 * Confirm contact DOI via token — POST /confirm/doi?token={token}.
 */
export const confirmContactDoi = publicTokenEndpoint(
	{
		path: '/confirm/doi',
		method: 'POST',
		rateLimit: 'doiConfirmation',
		rateLimitKeyMode: 'ip+token',
		cors: 'GET, POST, OPTIONS',
		resultMode: 'action',
	},
	async (ctx, { token }) => {
		const result = await ctx.runMutation<ConfirmDoiResult>(internal.topics.topics.confirmDoi, {
			token,
		});

		if (!result.success) {
			return {
				ok: false,
				reason: 'confirmation_failed',
				message: result.error ?? 'Failed to confirm subscription',
				status: 400,
			};
		}

		return {
			ok: true,
			data: {
				alreadyConfirmed: result.alreadyConfirmed ?? false,
				contactEmail: result.contactEmail,
				message: result.alreadyConfirmed
					? 'Your subscription was already confirmed'
					: 'Your subscription has been confirmed!',
			},
		};
	},
);
