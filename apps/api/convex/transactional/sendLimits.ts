/**
 * What `GET /api/v1/limits` answers (`publicApi/limitsHttp.ts`): the
 * transactional send caps in force and what is left of the asking key's daily
 * cap, read from the limiter's own state.
 *
 * The daily count is the bucket the intake charges (`./sendCaps.ts`), read
 * without charging it, so `remaining` is what the next send's verdict uses,
 * short of sends that land between the read and that send. The per-recipient
 * cap counts per template and address, so its count is read only for the pair
 * a request names (`recipientUsage`).
 *
 * Both are queries: they read the limiter's buckets and cannot charge,
 * create or extend one.
 */

import { v } from 'convex/values';
import { DAY } from '@convex-dev/rate-limiter';
import type { RecipientSendUsage, SendLimits } from '@owlat/public-contract';
import type { Doc } from '../_generated/dataModel';
import { internalQuery, type QueryCtx } from '../_generated/server';
import { getInstanceSettings } from '../lib/instanceSettings';
import {
	PER_API_KEY_DAILY_BUCKET,
	PER_API_KEY_DAILY_CONFIG,
	PER_RECIPIENT_BUCKET,
	perRecipientConfig,
	perRecipientKey,
	readBucketUsage,
} from './sendCaps';
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

/**
 * A token bucket drains in fractions of a send. Below this a count is taken as
 * whole, so float error does not turn 4 into 5 used or 1 into 0 left.
 */
const FRACTION_EPSILON = 1e-6;

/** The template a request names, as the send route resolves it: the ID wins over the slug. */
async function findTemplate(
	db: QueryCtx['db'],
	template: { transactionalId: string | null; slug: string | null }
): Promise<Doc<'transactionalEmails'> | null> {
	if (template.transactionalId !== null) {
		const id = db.normalizeId('transactionalEmails', template.transactionalId);
		return id ? await db.get(id) : null;
	}
	if (template.slug === null) return null;
	const slug = template.slug;
	return await db
		.query('transactionalEmails')
		.withIndex('by_slug', (q) => q.eq('slug', slug))
		.first();
}

/**
 * What one template sent to one address under the per-recipient cap, or null
 * when no template answers to the request. It reads the bucket the intake
 * charges and nothing else: no contact is looked up, so the answer says no
 * more about the address than the sends to it do.
 */
export const recipientUsage = internalQuery({
	args: {
		/** Normalised by the caller, as the send route stores it. */
		email: v.string(),
		transactionalId: v.union(v.string(), v.null()),
		slug: v.union(v.string(), v.null()),
		now: v.number(),
	},
	handler: async (ctx, args): Promise<RecipientSendUsage | null> => {
		const template = await findTemplate(ctx.db, args);
		if (!template) return null;
		const settings = await getInstanceSettings(ctx.db);
		const { perRecipient } = effectiveSendCaps(settings?.transactionalSendCaps);
		const isExempt = template.isRecipientCapExempt === true;
		const pair = { email: args.email, templateId: template._id, slug: template.slug, isExempt };
		// An exempt template or a cap that is off is neither checked nor charged.
		if (isExempt || !perRecipient.isEnabled) {
			return { ...pair, used: null, remaining: null, resetsAt: null };
		}
		const { count, windowMs } = perRecipient;
		const { used } = await readBucketUsage(
			ctx,
			PER_RECIPIENT_BUCKET,
			perRecipientKey(template._id, args.email),
			perRecipientConfig(count, windowMs),
			args.now
		);
		const drainsInMs = (used * windowMs) / count;
		return {
			...pair,
			used: Math.max(0, Math.ceil(used - FRACTION_EPSILON)),
			remaining: Math.max(0, Math.floor(count - used + FRACTION_EPSILON)),
			resetsAt:
				used <= FRACTION_EPSILON
					? null
					: new Date(args.now + Math.round(drainsInMs / 1000) * 1000).toISOString(),
		};
	},
});
