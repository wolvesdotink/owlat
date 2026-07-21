/** Compliance telemetry writers and bounded read helpers. */

import { v } from 'convex/values';
import type { DatabaseReader } from '../_generated/server';
import { internalMutation } from '../_generated/server';
import { startOfDayUtc } from '../analytics/sendingReputation';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const GMAIL_WINDOW_MS = DAY_MS;
const TELEMETRY_RETENTION_MS = 48 * HOUR_MS;
const UNSUBSCRIBE_RETENTION_MS = 30 * DAY_MS;
const GMAIL_VOLUME_SHARDS = 8;

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
		observedAt: v.number(),
	},
	handler: async (ctx, args) => {
		const receipt = await ctx.db
			.query('gmailDeliveryReceipts')
			.withIndex('by_message_id', (q) => q.eq('providerMessageId', args.providerMessageId))
			.unique();
		if (receipt) return { recorded: false };

		await ctx.db.insert('gmailDeliveryReceipts', {
			providerMessageId: args.providerMessageId,
			observedAt: args.observedAt,
		});
		const bucketHour = hourStart(args.observedAt);
		const shardKey = deterministicShard(args.providerMessageId);
		const bucket = await ctx.db
			.query('gmailVolumeBuckets')
			.withIndex('by_domain_hour_shard', (q) =>
				q
					.eq('primaryDomain', args.primaryDomain)
					.eq('hourStart', bucketHour)
					.eq('shardKey', shardKey)
			)
			.unique();
		if (bucket) {
			await ctx.db.patch(bucket._id, { deliveredCount: bucket.deliveredCount + 1 });
		} else {
			await ctx.db.insert('gmailVolumeBuckets', {
				primaryDomain: args.primaryDomain,
				hourStart: bucketHour,
				shardKey,
				deliveredCount: 1,
			});
		}
		return { recorded: true };
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

export async function readGmailVolumes(
	db: DatabaseReader,
	now: number
): Promise<GmailPrimaryDomainVolume[]> {
	const cutoff = now - GMAIL_WINDOW_MS;
	const buckets = await db
		.query('gmailVolumeBuckets')
		.withIndex('by_hour', (q) => q.gte('hourStart', hourStart(cutoff)))
		.collect(); // bounded: cleanup retains only 48 hours × 8 shards × active sending domains
	const totals = new Map<string, number>();
	for (const bucket of buckets) {
		// Hour buckets straddle the exact 24h boundary. Excluding the older hour
		// would undercount by up to 59m; include it and label the result approximate.
		totals.set(
			bucket.primaryDomain,
			(totals.get(bucket.primaryDomain) ?? 0) + bucket.deliveredCount
		);
	}
	return [...totals.entries()]
		.map(([primaryDomain, delivered24h]) => ({ primaryDomain, delivered24h }))
		.sort(
			(a, b) => b.delivered24h - a.delivered24h || a.primaryDomain.localeCompare(b.primaryDomain)
		);
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
		const receipts = await ctx.db
			.query('gmailDeliveryReceipts')
			.withIndex('by_observed_at', (q) => q.lt('observedAt', gmailCutoff))
			.collect(); // bounded: hourly cleanup limits this to newly expired receipts
		for (const row of receipts) await ctx.db.delete(row._id);
		const gmailBuckets = await ctx.db
			.query('gmailVolumeBuckets')
			.withIndex('by_hour', (q) => q.lt('hourStart', hourStart(gmailCutoff)))
			.collect(); // bounded: hourly cleanup limits this to newly expired buckets
		for (const row of gmailBuckets) await ctx.db.delete(row._id);
		const unsubscribeCutoff = startOfDayUtc(now - UNSUBSCRIBE_RETENTION_MS);
		const latencyRows = await ctx.db
			.query('unsubscribeLatencyBuckets')
			.withIndex('by_period', (q) => q.lt('periodStart', unsubscribeCutoff))
			.collect(); // bounded: one histogram row expires per day
		for (const row of latencyRows) await ctx.db.delete(row._id);
	},
});
