import { v } from 'convex/values';
import { internalAction, internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { getOptional } from '../lib/env';
import { normalizeIpReputationPayload } from '@owlat/shared/ipReadinessSync';
import { ipReadinessFieldValidators } from './readinessValidators';

/**
 * Sync IP warming state from the MTA's /ip-reputation endpoint.
 * Called every 5 minutes by cron job.
 *
 * The MTA tracks per-IP warming state (phase, daily cap, sent today,
 * bounce/deferral rates) in Redis. This action fetches that data and
 * caches it in the Convex database so queries can access it reactively.
 */
export const syncWarmingState = internalAction({
	args: {},
	handler: async (ctx) => {
		const mtaUrl = getOptional('MTA_INTERNAL_URL');
		const mtaApiKey = getOptional('MTA_API_KEY');

		if (!mtaUrl || !mtaApiKey) {
			// MTA not configured — skip sync silently
			return;
		}

		try {
			const response = await fetch(`${mtaUrl}/ip-reputation`, {
				headers: {
					Authorization: `Bearer ${mtaApiKey}`,
				},
			});

			if (!response.ok) {
				// eslint-disable-next-line no-console
				console.error(`[WarmingSync] MTA returned ${response.status}: ${response.statusText}`);
				return;
			}

			const normalized = normalizeIpReputationPayload(await response.json());
			if (!normalized) {
				console.error('[WarmingSync] MTA returned an invalid IP reputation payload');
				return;
			}

			await ctx.runMutation(internal.delivery.warmingSync.upsertWarmingState, {
				...normalized,
				syncedAt: Date.now(),
			});

			// Check if approaching capacity limit (for admin alerts)
			if (normalized.phase === 'graduated' && normalized.totalDailyCap > 0) {
				const usageRate = normalized.totalSentToday / normalized.totalDailyCap;
				if (usageRate > 0.8) {
					// eslint-disable-next-line no-console
					console.warn(
						`[WarmingSync] IP capacity alert: ${Math.round(usageRate * 100)}% of daily cap used ` +
							`(${normalized.totalSentToday.toLocaleString()} / ${normalized.totalDailyCap.toLocaleString()}). ` +
							`Consider adding more IPs.`
					);
				}
			}
		} catch (error) {
			// eslint-disable-next-line no-console
			console.error('[WarmingSync] Failed to sync warming state:', error);
		}
	},
});

/**
 * Upsert the warming state singleton row.
 */
export const upsertWarmingState = internalMutation({
	args: {
		phase: v.string(),
		totalDailyCap: v.number(),
		totalSentToday: v.number(),
		ipCount: v.number(),
		ips: v.array(
			v.object({
				ip: v.string(),
				phase: v.string(),
				currentDay: v.number(),
				dailyCap: v.number(),
				sentToday: v.number(),
				bounceRate: v.number(),
				deferralRate: v.number(),
				pool: v.string(),
				active: v.boolean(),
				...ipReadinessFieldValidators,
			})
		),
		syncedAt: v.number(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db.query('warmingState').first();

		if (existing) {
			await ctx.db.patch(existing._id, args);
		} else {
			await ctx.db.insert('warmingState', args);
		}
	},
});
