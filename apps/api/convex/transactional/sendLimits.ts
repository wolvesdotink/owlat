/**
 * What `GET /api/v1/limits` answers (`publicApi/limitsHttp.ts`): the
 * transactional send caps in force and what is left of the asking key's daily
 * cap, read from the limiter's own state.
 *
 * The daily count is the bucket the intake charges (`./sendCaps.ts`), read
 * without charging it, so `remaining` is what the next send's verdict uses,
 * short of sends that land between the read and that send. The per-recipient
 * cap counts per template and address, so it has no count of the key's to
 * report.
 */

import { v } from 'convex/values';
import { DAY } from '@convex-dev/rate-limiter';
import type { SendLimits } from '@owlat/public-contract';
import { internalQuery } from '../_generated/server';
import { getInstanceSettings } from '../lib/instanceSettings';
import { PER_API_KEY_DAILY_BUCKET, PER_API_KEY_DAILY_CONFIG, readBucketUsage } from './sendCaps';
import { effectiveSendCaps } from './sendCapsPolicy';

export const forApiKey = internalQuery({
	// `now` comes from the caller: a cached query result would otherwise keep
	// the day it was first computed in after midnight.
	args: { keyId: v.id('apiKeys'), now: v.number() },
	handler: async (ctx, args): Promise<SendLimits> => {
		const settings = await getInstanceSettings(ctx.db);
		const { perRecipient, perApiKeyDaily } = effectiveSendCaps(settings?.transactionalSendCaps);
		const recipientSends = {
			isEnabled: perRecipient.isEnabled,
			limit: perRecipient.count,
			windowSeconds: Math.round(perRecipient.windowMs / 1000),
		};
		// A cap that is off is neither checked nor charged, so its bucket says
		// nothing about today.
		if (!perApiKeyDaily.isEnabled) {
			return {
				dailySends: {
					isEnabled: false,
					limit: perApiKeyDaily.count,
					used: null,
					remaining: null,
					resetsAt: null,
				},
				recipientSends,
			};
		}
		const usage = await readBucketUsage(
			ctx,
			PER_API_KEY_DAILY_BUCKET,
			args.keyId,
			PER_API_KEY_DAILY_CONFIG,
			args.now
		);
		return {
			dailySends: {
				isEnabled: true,
				limit: perApiKeyDaily.count,
				used: usage.used,
				remaining: Math.max(0, perApiKeyDaily.count - usage.used),
				resetsAt: new Date(usage.windowStart + DAY).toISOString(),
			},
			recipientSends,
		};
	},
});
