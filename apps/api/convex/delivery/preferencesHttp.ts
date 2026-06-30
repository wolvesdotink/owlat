/**
 * Preference-centre HTTP endpoints — verify token (GET) and update
 * preferences (POST). Both are public, token-keyed `httpAction`s wrapped by
 * the **Public token endpoint (module)** for a uniform shell shape.
 *
 * See docs/adr/0030-public-token-endpoint-module.md.
 */

import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { publicTokenEndpoint } from '../lib/publicTokenEndpoint';
import type { TokenValidation } from './tokenValidation';

interface PreferenceData {
	email: string;
	firstName?: string;
	teamName: string;
	topics: Array<{
		_id: string;
		name: string;
		description?: string;
		subscribed: boolean;
	}>;
}

interface UpdateOutcome {
	success: boolean;
	reason?: string;
}

/**
 * Verify preference token — GET /prefs/verify/{token}. Outcome mode: an
 * expired token returns HTTP 200 `{ ok: false, reason }`.
 */
export const verifyPreferenceToken = publicTokenEndpoint(
	{
		path: '/prefs/verify/:token',
		method: 'GET',
		rateLimit: 'subscriptionManagement',
		rateLimitKeyMode: 'ip+token',
		cors: 'GET, OPTIONS',
		resultMode: 'outcome',
	},
	async (ctx, { token }) => {
		const validation = await ctx.runAction<TokenValidation>(
			internal.delivery.preferences.validateToken,
			{ token },
		);

		if (!validation.valid) {
			return { ok: false, reason: validation.reason ?? 'invalid_token' };
		}

		const preferences = await ctx.runQuery<PreferenceData | null>(
			internal.delivery.preferencesQueries.getContactPreferences,
			{ contactId: validation.contactId as Id<'contacts'> },
		);

		if (!preferences) {
			return { ok: false, reason: 'contact_not_found' };
		}

		return {
			ok: true,
			data: {
				email: preferences.email,
				firstName: preferences.firstName,
				teamName: preferences.teamName,
				topics: preferences.topics,
			},
		};
	},
);

interface UpdatePreferencesBody {
	globalUnsubscribe?: unknown;
	topicUpdates?: unknown;
}

/**
 * Update preferences — POST /prefs/update/{token}. Action mode: success
 * returns `{ ok: true, data: { message } }`; failure returns the locked
 * envelope `{ error: { message, code } }`.
 */
export const updatePreferences = publicTokenEndpoint(
	{
		path: '/prefs/update/:token',
		method: 'POST',
		rateLimit: 'subscriptionManagement',
		rateLimitKeyMode: 'ip+token',
		cors: 'POST, OPTIONS',
		body: 'json',
		resultMode: 'action',
	},
	async (ctx, { token, body }) => {
		const validation = await ctx.runAction<TokenValidation>(
			internal.delivery.preferences.validateToken,
			{ token },
		);

		if (!validation.valid) {
			return {
				ok: false,
				reason: validation.reason ?? 'invalid_token',
				message: 'Invalid or expired link',
				status: 400,
			};
		}

		const { globalUnsubscribe, topicUpdates } = (body ?? {}) as UpdatePreferencesBody;

		if (globalUnsubscribe !== undefined && typeof globalUnsubscribe !== 'boolean') {
			return {
				ok: false,
				reason: 'globalUnsubscribe_must_be_boolean',
				message: 'globalUnsubscribe must be a boolean',
				status: 400,
			};
		}

		if (topicUpdates !== undefined) {
			if (!Array.isArray(topicUpdates)) {
				return {
					ok: false,
					reason: 'topicUpdates_must_be_array',
					message: 'topicUpdates must be an array',
					status: 400,
				};
			}
			if (topicUpdates.length > 100) {
				return {
					ok: false,
					reason: 'too_many_topic_updates',
					message: 'Too many topic updates (max 100)',
					status: 400,
				};
			}
			for (const item of topicUpdates) {
				if (
					typeof item !== 'object' ||
					item === null ||
					typeof (item as { topicId: unknown }).topicId !== 'string' ||
					typeof (item as { subscribed: unknown }).subscribed !== 'boolean'
				) {
					return {
						ok: false,
						reason: 'invalid_topic_update_shape',
						message: 'Each update must have a string topicId and boolean subscribed',
						status: 400,
					};
				}
			}
		}

		const validatedUpdates = topicUpdates as
			| Array<{ topicId: string; subscribed: boolean }>
			| undefined;

		const formattedUpdates = validatedUpdates?.map((update) => ({
			topicId: update.topicId as Id<'topics'>,
			subscribed: update.subscribed,
		}));

		const result = await ctx.runMutation<UpdateOutcome>(
			internal.delivery.preferencesQueries.updateContactPreferences,
			{
				contactId: validation.contactId as Id<'contacts'>,
				globalUnsubscribe: globalUnsubscribe as boolean | undefined,
				topicUpdates: formattedUpdates,
			},
		);

		if (!result.success) {
			return {
				ok: false,
				reason: result.reason ?? 'update_failed',
				message: 'Failed to update preferences',
				status: 404,
			};
		}

		return { ok: true, data: { message: 'Preferences updated successfully' } };
	},
);
