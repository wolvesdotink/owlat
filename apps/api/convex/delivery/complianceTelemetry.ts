/** Compliance telemetry writers and bounded read helpers. */

import { v } from 'convex/values';
import type { DatabaseReader, MutationCtx } from '../_generated/server';
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { startOfDayUtc } from '../analytics/sendingReputation';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const GMAIL_WINDOW_MS = DAY_MS;
const TELEMETRY_RETENTION_MS = 48 * HOUR_MS;
export const GMAIL_ACCEPTED_AT_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const GMAIL_ACCEPTED_AT_MAX_AGE_MS = TELEMETRY_RETENTION_MS;
const UNSUBSCRIBE_RETENTION_MS = 30 * DAY_MS;
export const COMPLIANCE_CLEANUP_BATCH_SIZE = 128;
export const GMAIL_DASHBOARD_DOMAIN_LIMIT = 100;
export const GMAIL_VOLUME_SHARDS = 8;
export const GMAIL_ROLLUP_REFRESH_DELAY_MS = 60 * 1000;
const GMAIL_ROLLUP_JOB_STALE_MS = 10 * 60 * 1000;
const GMAIL_MAX_BUCKETS_PER_WINDOW = (GMAIL_WINDOW_MS / HOUR_MS + 1) * GMAIL_VOLUME_SHARDS;

export const GMAIL_BULK_SENDER_THRESHOLD = 5_000;
export const GMAIL_PROXIMITY_WARNING_THRESHOLD = 4_000;
export const UNSUBSCRIBE_HONOR_WINDOW_MS = 48 * HOUR_MS;

/** Inclusive histogram upper bounds; the last bucket catches all larger values. */
export const UNSUBSCRIBE_LATENCY_BOUNDS_MS = [
	100,
	250,
	500,
	1_000,
	5_000,
	30_000,
	5 * 60_000,
	60 * 60_000,
	24 * HOUR_MS,
	UNSUBSCRIBE_HONOR_WINDOW_MS,
	7 * DAY_MS,
] as const;

function hourStart(epochMs: number): number {
	return Math.floor(epochMs / HOUR_MS) * HOUR_MS;
}

type GmailHourlyCount = { hourStart: number; deliveredCount: number };

function currentWindowCounts(counts: readonly GmailHourlyCount[], now: number): GmailHourlyCount[] {
	const oldestHour = hourStart(now - GMAIL_WINDOW_MS);
	const newestHour = hourStart(now);
	return counts.filter((count) => count.hourStart >= oldestHour && count.hourStart <= newestHour);
}

function deterministicShard(value: string): number {
	let hash = 0;
	for (let index = 0; index < value.length; index++) {
		hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
	}
	return hash % GMAIL_VOLUME_SHARDS;
}

export function latencyBucketIndex(durationMs: number): number {
	const normalized = Math.max(0, durationMs);
	const index = UNSUBSCRIBE_LATENCY_BOUNDS_MS.findIndex((bound) => normalized <= bound);
	return index === -1 ? UNSUBSCRIBE_LATENCY_BOUNDS_MS.length - 1 : index;
}

export function histogramPercentileUpperBound(
	bucketCounts: readonly number[],
	percentile: number
): number | null {
	const total = bucketCounts.reduce((sum, count) => sum + count, 0);
	if (total === 0) return null;
	const rank = Math.max(1, Math.ceil(total * percentile));
	let cumulative = 0;
	for (let index = 0; index < bucketCounts.length; index++) {
		cumulative += bucketCounts[index] ?? 0;
		if (cumulative >= rank) return UNSUBSCRIBE_LATENCY_BOUNDS_MS[index] ?? null;
	}
	return null;
}

export const recordGmailDelivery = internalMutation({
	args: {
		providerMessageId: v.string(),
		primaryDomain: v.string(),
		acceptedAt: v.number(),
	},
	handler: async (ctx, args) => {
		const ingestedAt = Date.now();
		const receipt = await ctx.db
			.query('gmailDeliveryReceipts')
			.withIndex('by_message_id', (q) => q.eq('providerMessageId', args.providerMessageId))
			.unique();
		if (receipt) return { recorded: false };

		await ctx.db.insert('gmailDeliveryReceipts', {
			providerMessageId: args.providerMessageId,
			acceptedAt: args.acceptedAt,
			ingestedAt,
		});

		// The authenticated MTA's remote-DATA acceptance time places the event in
		// the measurement window; server ingest time owns receipt retention. Small
		// positive clock skew is clamped to ingest time. Events outside the 48-hour
		// telemetry horizon, or beyond the explicit future-skew allowance, retain
		// an idempotency receipt but do not create a volume bucket.
		if (
			!Number.isFinite(args.acceptedAt) ||
			args.acceptedAt < ingestedAt - GMAIL_ACCEPTED_AT_MAX_AGE_MS
		) {
			return { recorded: false, reason: 'stale_accepted_at' as const };
		}
		if (args.acceptedAt > ingestedAt + GMAIL_ACCEPTED_AT_FUTURE_SKEW_MS) {
			return { recorded: false, reason: 'future_accepted_at' as const };
		}

		const boundedAcceptedAt = Math.min(args.acceptedAt, ingestedAt);
		const acceptedHour = hourStart(boundedAcceptedAt);
		if (acceptedHour >= hourStart(ingestedAt - GMAIL_WINDOW_MS)) {
			const shardKey = deterministicShard(args.providerMessageId);
			const bucket = await ctx.db
				.query('gmailVolumeBuckets')
				.withIndex('by_domain_hour_shard', (q) =>
					q
						.eq('primaryDomain', args.primaryDomain)
						.eq('hourStart', acceptedHour)
						.eq('shardKey', shardKey)
				)
				.unique();
			if (bucket) {
				await ctx.db.patch(bucket._id, { deliveredCount: bucket.deliveredCount + 1 });
			} else {
				await ctx.db.insert('gmailVolumeBuckets', {
					primaryDomain: args.primaryDomain,
					hourStart: acceptedHour,
					shardKey,
					deliveredCount: 1,
				});
			}

			const pendingRefresh = await ctx.db
				.query('gmailDomainVolumeRollupJobs')
				.withIndex('by_domain', (q) => q.eq('primaryDomain', args.primaryDomain))
				.unique();
			if (!pendingRefresh) {
				const jobId = await ctx.db.insert('gmailDomainVolumeRollupJobs', {
					primaryDomain: args.primaryDomain,
					scheduledAt: ingestedAt,
				});
				await ctx.scheduler.runAfter(
					GMAIL_ROLLUP_REFRESH_DELAY_MS,
					internal.delivery.complianceTelemetry.refreshGmailDomainVolume,
					{ jobId, primaryDomain: args.primaryDomain }
				);
			}
		}
		return { recorded: true };
	},
});

async function materializeGmailDomainVolume(
	ctx: MutationCtx,
	primaryDomain: string,
	now: number
): Promise<void> {
	const buckets = await ctx.db
		.query('gmailVolumeBuckets')
		.withIndex('by_domain_hour_shard', (q) =>
			q
				.eq('primaryDomain', primaryDomain)
				.gte('hourStart', hourStart(now - GMAIL_WINDOW_MS))
				.lte('hourStart', hourStart(now))
		)
		.take(GMAIL_MAX_BUCKETS_PER_WINDOW);
	const totalsByHour = new Map<number, number>();
	for (const bucket of buckets) {
		totalsByHour.set(
			bucket.hourStart,
			(totalsByHour.get(bucket.hourStart) ?? 0) + bucket.deliveredCount
		);
	}
	const hourlyCounts = [...totalsByHour.entries()]
		.map(([countHour, deliveredCount]) => ({ hourStart: countHour, deliveredCount }))
		.sort((left, right) => left.hourStart - right.hourStart);
	const deliveredCount = hourlyCounts.reduce((sum, count) => sum + count.deliveredCount, 0);
	const rollup = await ctx.db
		.query('gmailDomainVolumeRollups')
		.withIndex('by_domain', (q) => q.eq('primaryDomain', primaryDomain))
		.unique();
	if (deliveredCount === 0) {
		if (rollup) await ctx.db.delete(rollup._id);
		return;
	}
	if (rollup) {
		await ctx.db.patch(rollup._id, { hourlyCounts, deliveredCount, windowRefreshedAt: now });
	} else {
		await ctx.db.insert('gmailDomainVolumeRollups', {
			primaryDomain,
			hourlyCounts,
			deliveredCount,
			windowRefreshedAt: now,
		});
	}
}

export const refreshGmailDomainVolume = internalMutation({
	args: {
		jobId: v.id('gmailDomainVolumeRollupJobs'),
		primaryDomain: v.string(),
	},
	handler: async (ctx, args) => {
		const job = await ctx.db.get(args.jobId);
		if (!job || job.primaryDomain !== args.primaryDomain) return { refreshed: false };
		await materializeGmailDomainVolume(ctx, args.primaryDomain, Date.now());
		await ctx.db.delete(job._id);
		return { refreshed: true };
	},
});

export const recordUnsubscribeLatency = internalMutation({
	args: { durationMs: v.number(), recordedAt: v.number() },
	handler: async (ctx, args) => {
		const periodStart = startOfDayUtc(args.recordedAt);
		const bucket = await ctx.db
			.query('unsubscribeLatencyBuckets')
			.withIndex('by_period', (q) => q.eq('periodStart', periodStart))
			.unique();
		const index = latencyBucketIndex(args.durationMs);
		const counts =
			bucket?.bucketCounts.slice() ?? Array(UNSUBSCRIBE_LATENCY_BOUNDS_MS.length).fill(0);
		counts[index] = (counts[index] ?? 0) + 1;
		if (bucket) {
			await ctx.db.patch(bucket._id, {
				bucketCounts: counts,
				totalSamples: bucket.totalSamples + 1,
				lastRecordedAt: args.recordedAt,
			});
		} else {
			await ctx.db.insert('unsubscribeLatencyBuckets', {
				periodStart,
				bucketCounts: counts,
				totalSamples: 1,
				lastRecordedAt: args.recordedAt,
			});
		}
	},
});

export interface GmailPrimaryDomainVolume {
	primaryDomain: string;
	delivered24h: number;
}

export interface GmailVolumeReadResult {
	domains: GmailPrimaryDomainVolume[];
	isDomainListTruncated: boolean;
	domainLimit: number;
}

export async function readGmailVolumes(db: DatabaseReader): Promise<GmailVolumeReadResult> {
	const rows = await db
		.query('gmailDomainVolumeRollups')
		.withIndex('by_delivered_count')
		.order('desc')
		.take(GMAIL_DASHBOARD_DOMAIN_LIMIT + 1);
	return {
		domains: rows
			.slice(0, GMAIL_DASHBOARD_DOMAIN_LIMIT)
			.map((row) => ({
				primaryDomain: row.primaryDomain,
				delivered24h: row.deliveredCount,
			}))
			.sort(
				(left, right) =>
					right.delivered24h - left.delivered24h ||
					left.primaryDomain.localeCompare(right.primaryDomain)
			),
		isDomainListTruncated: rows.length > GMAIL_DASHBOARD_DOMAIN_LIMIT,
		domainLimit: GMAIL_DASHBOARD_DOMAIN_LIMIT,
	};
}

export async function readUnsubscribeLatency(db: DatabaseReader, now: number) {
	const cutoff = now - UNSUBSCRIBE_RETENTION_MS;
	const rows = await db
		.query('unsubscribeLatencyBuckets')
		.withIndex('by_period', (q) => q.gte('periodStart', startOfDayUtc(cutoff)))
		.collect(); // bounded: one row per UTC day, retained for 30 days
	const counts = Array(UNSUBSCRIBE_LATENCY_BOUNDS_MS.length).fill(0) as number[];
	let sampleCount = 0;
	for (const row of rows) {
		sampleCount += row.totalSamples;
		for (let index = 0; index < counts.length; index++) {
			counts[index] = (counts[index] ?? 0) + (row.bucketCounts[index] ?? 0);
		}
	}
	const p95Ms = histogramPercentileUpperBound(counts, 0.95);
	return {
		p95Ms,
		sampleCount,
		exceedsHonorWindow: p95Ms !== null && p95Ms > UNSUBSCRIBE_HONOR_WINDOW_MS,
	};
}

export const cleanupComplianceTelemetry = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const gmailCutoff = now - TELEMETRY_RETENTION_MS;
		const expiredReceipts = await ctx.db
			.query('gmailDeliveryReceipts')
			.withIndex('by_ingested_at', (q) => q.gt('ingestedAt', 0).lt('ingestedAt', gmailCutoff))
			.take(COMPLIANCE_CLEANUP_BATCH_SIZE);
		const expiredLegacyReceipts = await ctx.db
			.query('gmailDeliveryReceipts')
			.withIndex('by_observed_at', (q) => q.gt('observedAt', 0).lt('observedAt', gmailCutoff))
			.take(COMPLIANCE_CLEANUP_BATCH_SIZE);
		const expiredBuckets = await ctx.db
			.query('gmailVolumeBuckets')
			.withIndex('by_hour', (q) => q.lt('hourStart', hourStart(gmailCutoff)))
			.take(COMPLIANCE_CLEANUP_BATCH_SIZE);
		const futureReceipts = await ctx.db
			.query('gmailDeliveryReceipts')
			.withIndex('by_ingested_at', (q) => q.gt('ingestedAt', now))
			.take(COMPLIANCE_CLEANUP_BATCH_SIZE);
		const futureLegacyReceipts = await ctx.db
			.query('gmailDeliveryReceipts')
			.withIndex('by_observed_at', (q) => q.gt('observedAt', now))
			.take(COMPLIANCE_CLEANUP_BATCH_SIZE);
		const futureGmailBuckets = await ctx.db
			.query('gmailVolumeBuckets')
			.withIndex('by_hour', (q) => q.gt('hourStart', hourStart(now)))
			.take(COMPLIANCE_CLEANUP_BATCH_SIZE);
		const staleRollupJobs = await ctx.db
			.query('gmailDomainVolumeRollupJobs')
			.withIndex('by_scheduled_at', (q) => q.lt('scheduledAt', now - GMAIL_ROLLUP_JOB_STALE_MS))
			.take(COMPLIANCE_CLEANUP_BATCH_SIZE);
		for (const job of staleRollupJobs) {
			await ctx.db.patch(job._id, { scheduledAt: now });
			await ctx.scheduler.runAfter(
				0,
				internal.delivery.complianceTelemetry.refreshGmailDomainVolume,
				{ jobId: job._id, primaryDomain: job.primaryDomain }
			);
		}

		const receiptRows = new Map(
			[
				...expiredReceipts,
				...expiredLegacyReceipts,
				...futureReceipts,
				...futureLegacyReceipts,
			].map((row) => [String(row._id), row] as const)
		);
		for (const row of receiptRows.values()) await ctx.db.delete(row._id);
		const bucketRows = new Map(
			[...expiredBuckets, ...futureGmailBuckets].map((row) => [String(row._id), row] as const)
		);
		for (const row of bucketRows.values()) await ctx.db.delete(row._id);

		const rollups = await ctx.db
			.query('gmailDomainVolumeRollups')
			.withIndex('by_window_refreshed_at', (q) => q.lt('windowRefreshedAt', hourStart(now)))
			.take(COMPLIANCE_CLEANUP_BATCH_SIZE);
		for (const rollup of rollups) {
			const hourlyCounts = currentWindowCounts(rollup.hourlyCounts, now);
			const deliveredCount = hourlyCounts.reduce((sum, count) => sum + count.deliveredCount, 0);
			if (deliveredCount === 0) {
				await ctx.db.delete(rollup._id);
			} else {
				await ctx.db.patch(rollup._id, {
					hourlyCounts,
					deliveredCount,
					windowRefreshedAt: now,
				});
			}
		}
		const unsubscribeCutoff = startOfDayUtc(now - UNSUBSCRIBE_RETENTION_MS);
		const latencyRows = await ctx.db
			.query('unsubscribeLatencyBuckets')
			.withIndex('by_period', (q) => q.lt('periodStart', unsubscribeCutoff))
			.take(COMPLIANCE_CLEANUP_BATCH_SIZE);
		for (const row of latencyRows) await ctx.db.delete(row._id);

		const batches = [
			expiredReceipts,
			expiredLegacyReceipts,
			expiredBuckets,
			futureReceipts,
			futureLegacyReceipts,
			futureGmailBuckets,
			staleRollupJobs,
			rollups,
			latencyRows,
		];
		const hasMore = batches.some((batch) => batch.length === COMPLIANCE_CLEANUP_BATCH_SIZE);
		if (hasMore) {
			await ctx.scheduler.runAfter(
				0,
				internal.delivery.complianceTelemetry.cleanupComplianceTelemetry,
				{}
			);
		}
		return {
			deleted: receiptRows.size + bucketRows.size + latencyRows.length,
			refreshedRollups: rollups.length,
			rescheduledRollupJobs: staleRollupJobs.length,
			continuationScheduled: hasMore,
		};
	},
});
