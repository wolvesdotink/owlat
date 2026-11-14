/**
 * The instance admin's choice of transactional send caps
 * (`instanceSettings.transactionalSendCaps`): read and saved from the API
 * settings page, beside the keys whose requests the caps refuse with a 429.
 * The intake (`./sendCaps.ts`) reads the stored row on every send, so a saved
 * change decides the next request without a deploy.
 */

import { v } from 'convex/values';
import { adminQuery, authedMutation } from '../lib/authedFunctions';
import { getInstanceSettings, upsertInstanceSettings } from '../lib/instanceSettings';
import { hasPermission, requirePermission } from '../lib/sessionOrganization';
import { recordAuditLog } from '../lib/auditLog';
import { throwInvalidInput } from '../_utils/errors';
import {
	DEFAULT_TRANSACTIONAL_SEND_CAPS,
	TRANSACTIONAL_SEND_CAP_BOUNDS,
	effectiveSendCaps,
	sendCapsInputError,
} from './sendCapsPolicy';

// flag-exempt: the API settings page shows the caps whether or not transactional sending is on.
export const get = adminQuery({
	args: {},
	handler: async (ctx) => {
		const stored = (await getInstanceSettings(ctx.db))?.transactionalSendCaps;
		return {
			caps: effectiveSendCaps(stored),
			defaults: DEFAULT_TRANSACTIONAL_SEND_CAPS,
			bounds: TRANSACTIONAL_SEND_CAP_BOUNDS,
			updatedAt: stored?.updatedAt ?? null,
		};
	},
});

/**
 * Save both caps. Each is switched off with `isEnabled: false`, never with a
 * zero; its count is kept for when it is switched back on.
 */
// flag-exempt: saved from the API settings page, which renders outside the transactional route.
export const update = authedMutation({
	args: {
		perRecipient: v.object({ isEnabled: v.boolean(), count: v.number(), windowMs: v.number() }),
		perApiKeyDaily: v.object({ isEnabled: v.boolean(), count: v.number() }),
	},
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'settings:manage'),
			'Only owners and admins can change the transactional send caps'
		);
		const problem = sendCapsInputError(args);
		if (problem) throwInvalidInput(problem);

		const transactionalSendCaps = {
			perRecipient: args.perRecipient,
			perApiKeyDaily: args.perApiKeyDaily,
			updatedAt: Date.now(),
			updatedBy: session.userId,
		};
		const settingsId = await upsertInstanceSettings(ctx, { transactionalSendCaps });
		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'settings.transactional_send_caps_updated',
			resource: 'settings',
			resourceId: settingsId,
			details: {
				isPerRecipientEnabled: args.perRecipient.isEnabled,
				perRecipientCount: args.perRecipient.count,
				perRecipientWindowMs: args.perRecipient.windowMs,
				isPerApiKeyDailyEnabled: args.perApiKeyDaily.isEnabled,
				perApiKeyDailyCount: args.perApiKeyDaily.count,
			},
		});
		return effectiveSendCaps(transactionalSendCaps);
	},
});
