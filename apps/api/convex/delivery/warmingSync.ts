import { v } from 'convex/values';
import { internalAction, internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { getOptional } from '../lib/env';
import { getWarmingDisplayCapForDay, GRADUATED_DISPLAY_CAP } from '@owlat/shared/warming';

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

			const data = await response.json() as {
				date: string;
				ips: Array<{
					ip: string;
					sent: number;
					delivered: number;
					bounced: number;
					deferred: number;
					bounceRate: number;
					warmingPhase: string;
					warmingDay: number;
					pool: string;
					active: boolean;
				}>;
			};

			// Filter to campaign pool IPs only (transactional IPs have no warming limits)
			const campaignIps = data.ips.filter((ip) => ip.pool === 'campaign');

			if (campaignIps.length === 0) {
				// No campaign IPs found — write a default state
				await ctx.runMutation(internal.delivery.warmingSync.upsertWarmingState, {
					phase: 'graduated',
					totalDailyCap: 999999,
					totalSentToday: 0,
					ipCount: 0,
					ips: [],
					syncedAt: Date.now(),
				});
				return;
			}

			// Compute aggregate state
			let totalDailyCap = 0;
			let totalSentToday = 0;
			let anyRamp = false;
			let anyPlateau = false;

			const ips = campaignIps.map((ip) => {
				// The MTA warming schedule gives dailyCap per IP. Graduated IPs have no
				// real cap (Infinity), so use the finite display ceiling for projections.
				const dailyCap =
					ip.warmingPhase === 'graduated' ? GRADUATED_DISPLAY_CAP : getWarmingDisplayCapForDay(ip.warmingDay);
				totalDailyCap += dailyCap;
				totalSentToday += ip.sent;

				if (ip.warmingPhase === 'ramp') anyRamp = true;
				if (ip.warmingPhase === 'plateau') anyPlateau = true;

				// Compute per-IP rates
				const bounceRate = ip.sent > 0 ? ip.bounced / ip.sent : 0;
				const deferralRate = ip.sent > 0 ? ip.deferred / ip.sent : 0;

				return {
					ip: ip.ip,
					phase: ip.warmingPhase || 'unknown',
					currentDay: ip.warmingDay,
					dailyCap,
					sentToday: ip.sent,
					bounceRate: Math.round(bounceRate * 10000) / 10000,
					deferralRate: Math.round(deferralRate * 10000) / 10000,
					pool: ip.pool,
					active: ip.active,
				};
			});

			// Determine overall phase
			let overallPhase: string;
			if (anyPlateau) {
				overallPhase = 'plateau';
			} else if (anyRamp) {
				overallPhase = 'ramp';
			} else {
				overallPhase = 'graduated';
			}

			await ctx.runMutation(internal.delivery.warmingSync.upsertWarmingState, {
				phase: overallPhase,
				totalDailyCap,
				totalSentToday,
				ipCount: campaignIps.length,
				ips,
				syncedAt: Date.now(),
			});

			// Check if approaching capacity limit (for admin alerts)
			if (overallPhase === 'graduated' && totalDailyCap > 0) {
				const usageRate = totalSentToday / totalDailyCap;
				if (usageRate > 0.8) {
					// eslint-disable-next-line no-console
					console.warn(
						`[WarmingSync] IP capacity alert: ${Math.round(usageRate * 100)}% of daily cap used ` +
						`(${totalSentToday.toLocaleString()} / ${totalDailyCap.toLocaleString()}). ` +
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
		ips: v.array(v.object({
			ip: v.string(),
			phase: v.string(),
			currentDay: v.number(),
			dailyCap: v.number(),
			sentToday: v.number(),
			bounceRate: v.number(),
			deferralRate: v.number(),
			pool: v.string(),
			active: v.boolean(),
		})),
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
