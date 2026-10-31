import { type ObjectType, v } from 'convex/values';
import { internalAction, type MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import { getMtaConfig, mtaFetch } from '../mail/mtaClient';
import { normalizeIpReputationPayload } from '@owlat/mta-protocol/ipReputation';
import { normalizeDeliverabilityRoutingSnapshot } from '@owlat/shared/deliverabilityRouting';
import {
	applyRoutingSnapshot,
	DELIVERABILITY_SIGNAL_MAX_AGE_MS,
	routingSnapshotFields,
} from './deliverabilityRouting';
import { warmingStateFields } from '../schema/delivery';
import { logError, logWarn } from '../lib/runtimeLog';
import type { AssertTrue, Exact } from '../lib/typeAssert';
import { ipv6SendingAddresses } from './checklistIpv6';
import { resolveIpv6RegressionAlerts } from './checklistEvidence';

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

			const now = Date.now();
			const routing =
				typeof payload === 'object' && payload !== null && 'routing' in payload
					? normalizeDeliverabilityRoutingSnapshot(payload.routing, now)
					: null;
			const isRoutingFresh =
				routing !== null &&
				routing.generatedAt <= now + 2 * 60 * 1000 &&
				now - routing.generatedAt <= DELIVERABILITY_SIGNAL_MAX_AGE_MS;
			if (
				organizationId &&
				!isRoutingFresh &&
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

			await ctx.runMutation(internal.delivery.warmingSync.commitWarmingSync, {
				...normalized,
				syncedAt: now,
				...(organizationId ? { organizationId } : {}),
				...(organizationId && isRoutingFresh
					? {
							routing: {
								generatedAt: routing.generatedAt,
								signals: routing.signals,
								appliedAt: now,
							},
						}
					: {}),
			});

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

const upsertWarmingStateArgs = { ...warmingStateFields, organizationId: v.optional(v.string()) };

/**
 * Upsert the warming state singleton row. `organizationId` is not stored: it
 * scopes the IPv6 alert clean-up when the new snapshot shows IPv6 off.
 */
async function writeWarmingState(
	ctx: MutationCtx,
	{ organizationId, ...snapshot }: ObjectType<typeof upsertWarmingStateArgs>
): Promise<void> {
	const existing = await ctx.db.query('warmingState').first();

	if (existing) {
		// An MTA that predates `pools` omits it; clear the stored lists instead
		// of leaving ones that no longer describe the running pools.
		await ctx.db.patch(existing._id, { ...snapshot, pools: snapshot.pools });
	} else {
		await ctx.db.insert('warmingState', snapshot);
	}

	if (organizationId && ipv6SendingAddresses(snapshot).length === 0) {
		await resolveIpv6RegressionAlerts(ctx, organizationId, snapshot.syncedAt);
	}
}

/**
 * The warming sync's one commit: the warming snapshot and, when the MTA's
 * routing snapshot was fresh, that snapshot onto the route states.
 */
export const commitWarmingSync = internalMutation({
	args: {
		...upsertWarmingStateArgs,
		routing: v.optional(
			v.object({
				generatedAt: routingSnapshotFields.generatedAt,
				signals: routingSnapshotFields.signals,
				appliedAt: routingSnapshotFields.appliedAt,
			})
		),
	},
	handler: async (ctx, { routing, ...snapshot }) => {
		await writeWarmingState(ctx, snapshot);
		if (routing && snapshot.organizationId) {
			await applyRoutingSnapshot(ctx, { organizationId: snapshot.organizationId, ...routing });
		}
	},
});

/**
 * The warming snapshot on its own. Nothing in this release calls it: an action
 * of the previous release still mid-sync during the deploy does, so it leaves
 * a snapshot newer than its own in place. Remove after release 0.6.17.
 */
export const upsertWarmingState = internalMutation({
	args: upsertWarmingStateArgs,
	handler: async (ctx, args) => {
		const existing = await ctx.db.query('warmingState').first(); // bounded: singleton row
		if (existing && existing.syncedAt > args.syncedAt) return;
		await writeWarmingState(ctx, args);
	},
});
