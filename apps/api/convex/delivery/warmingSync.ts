import { type ObjectType, v } from 'convex/values';
import { internalAction, internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { getMtaConfig, mtaFetch } from '../mail/mtaClient';
import { normalizeIpReputationPayload } from '@owlat/mta-protocol/ipReputation';
import { normalizeDeliverabilityRoutingSnapshot } from '@owlat/shared/deliverabilityRouting';
import { DELIVERABILITY_SIGNAL_MAX_AGE_MS } from './deliverabilityRouting';
import { warmingStateFields } from '../schema/delivery';
import { logError, logWarn } from '../lib/runtimeLog';
import type { AssertTrue, Exact } from '../lib/typeAssert';

/**
 * The re-check re-observes every configured address from live DNS before it
 * answers, so it gets more room than a plain read. It fails soft either way.
 */
const IDENTITY_RECHECK_TIMEOUT_MS = 30_000;

/**
 * Compile-time proof that the normalizer's DTO is exactly the stored row minus
 * `syncedAt`: a field one side gains and the other lacks is a build error here,
 * not a sync that Convex starts rejecting at runtime while the cron fails soft.
 */
export type WarmingSnapshotMatchesSchema = AssertTrue<
	Exact<
		NonNullable<ReturnType<typeof normalizeIpReputationPayload>> & { syncedAt: number },
		ObjectType<typeof warmingStateFields>
	>
>;

/**
 * Sync IP warming state from the MTA's /ip-reputation endpoint.
 * Called every 5 minutes by cron job.
 *
 * The MTA tracks per-IP warming state (phase, daily cap, sent today,
 * bounce/deferral rates) in Redis. This action fetches that data and
 * caches it in the Convex database so queries can access it reactively.
 *
 * The per-IP identity verdicts (PTR, FCrDNS, source address, IPv6 SPF) inside
 * that payload are what the MTA's hourly identity sweep last stored. A
 * checklist "Verify now" passes `recheckIdentity` so the MTA re-observes them
 * from live DNS first; otherwise an operator who has just fixed a PTR record
 * would be judged against a verdict up to an hour old.
 */
export const syncWarmingState = internalAction({
	args: { recheckIdentity: v.optional(v.boolean()) },
	handler: async (ctx, args) => {
		const mta = getMtaConfig();
		// MTA not configured — skip sync silently
		if (!mta) return;

		try {
			const organizationId = await ctx.runQuery(
				internal.campaigns.sendQueries.getSingletonOrganizationId,
				{}
			);
			if (args.recheckIdentity) {
				// Fail soft: a failed re-check leaves the stored verdicts in place,
				// and the validators' freshness window still applies to them.
				try {
					const recheck = await mtaFetch(
						mta,
						'/identity/recheck',
						{ method: 'POST' },
						IDENTITY_RECHECK_TIMEOUT_MS
					);
					if (!recheck.ok) {
						logWarn('[WarmingSync] MTA rejected the outbound identity re-check', {
							status: recheck.status,
						});
					}
				} catch (error) {
					logWarn('[WarmingSync] MTA outbound identity re-check failed', { error });
				}
			}

			const query = organizationId ? `?${new URLSearchParams({ organizationId })}` : '';
			const response = await mtaFetch(mta, `/ip-reputation${query}`);

			if (!response.ok) {
				logError('[WarmingSync] MTA rejected the IP reputation request', {
					status: response.status,
					statusText: response.statusText,
					organizationId,
				});
				return;
			}

			const payload: unknown = await response.json();
			const normalized = normalizeIpReputationPayload(payload);
			if (!normalized) {
				logError('[WarmingSync] MTA returned an invalid IP reputation payload', {
					organizationId,
				});
				return;
			}

			await ctx.runMutation(internal.delivery.warmingSync.upsertWarmingState, {
				...normalized,
				syncedAt: Date.now(),
			});

			const now = Date.now();
			const routing =
				typeof payload === 'object' && payload !== null && 'routing' in payload
					? normalizeDeliverabilityRoutingSnapshot(payload.routing, now)
					: null;
			if (
				organizationId &&
				routing &&
				routing.generatedAt <= now + 2 * 60 * 1000 &&
				now - routing.generatedAt <= DELIVERABILITY_SIGNAL_MAX_AGE_MS
			) {
				await ctx.runMutation(internal.delivery.deliverabilityRouting.applySnapshot, {
					organizationId,
					generatedAt: routing.generatedAt,
					signals: routing.signals,
					appliedAt: now,
				});
			} else if (
				organizationId &&
				typeof payload === 'object' &&
				payload !== null &&
				'routing' in payload
			) {
				logError('[WarmingSync] MTA returned stale or invalid deliverability routing signals', {
					organizationId,
					generatedAt: routing?.generatedAt,
					now,
				});
			}

			// Check if approaching capacity limit (for admin alerts)
			if (normalized.phase === 'graduated' && normalized.totalDailyCap > 0) {
				const usageRate = normalized.totalSentToday / normalized.totalDailyCap;
				if (usageRate > 0.8) {
					logWarn(
						`[WarmingSync] IP capacity alert: ${Math.round(usageRate * 100)}% of daily cap used ` +
							`(${normalized.totalSentToday.toLocaleString()} / ${normalized.totalDailyCap.toLocaleString()}). ` +
							`Consider adding more IPs.`
					);
				}
			}
		} catch (error) {
			// Fail soft: the cron runs again next tick and the last good warming
			// state stays in place rather than being clobbered with a guess.
			logError('[WarmingSync] failed to sync warming state', { mtaUrl: mta.baseUrl, error });
		}
	},
});

/**
 * Upsert the warming state singleton row.
 */
export const upsertWarmingState = internalMutation({
	args: warmingStateFields,
	handler: async (ctx, args) => {
		const existing = await ctx.db.query('warmingState').first();

		if (existing) {
			await ctx.db.patch(existing._id, args);
		} else {
			await ctx.db.insert('warmingState', args);
		}
	},
});
