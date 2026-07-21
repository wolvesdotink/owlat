/**
 * Sending reputation (module) — the only writer of the scope-discriminated
 * `sendingReputation` table, with one summarizer behind a read-side seam that
 * every reader (the session-auth shell `reputationQueries.ts`, the
 * platform-admin shell `platformAdmin/queries.ts`, the control-plane reporter)
 * crosses.
 *
 * Shape (ADR-0042; sharded write path — FIX 3a-1):
 *   - `recordEvent` is the single writer and the send-event hot path. The Send
 *     lifecycle's `reputation_update` effect schedules it per recipient; it
 *     bumps a random SHARD of the org day-bucket always and a random shard of
 *     the domain day-bucket when a sending domain is present — nothing else, so
 *     the per-event transaction stays narrow (no inline window scan).
 *   - `summarize` / `summarizeDomains` are the only places the rolling window
 *     is summed; they sum ACROSS all shards, so the shard split is invisible to
 *     readers. Bounce/complaint rate + risk level are derived on read, never
 *     stored. Reader-typed (`DatabaseReader`), so they run in both query and
 *     mutation ctx and the writer/reader cannot disagree about the number.
 *   - `evaluateAutoEnforce` is the auto-enforce DECISION, off the hot path: it
 *     runs on the reputation cron, summarizes the org window once per tick, and
 *     escalates when risk is `high`/`critical`. Moving it here removes the wide
 *     per-event `.collect()` `recordEvent` used to do.
 *   - `recalculateAll` is the cleanup cron: it ages out >60-day buckets across
 *     both scopes. Risk no longer needs periodic recalculation — it is derived.
 *   - `autoEnforceReputation` is the unchanged enforce executor (delegates to
 *     the **Abuse status (module)** per ADR-0011).
 *
 * See docs/adr/0042-sending-reputation-module.md.
 */

import { v } from 'convex/values';
import { internalMutation, type DatabaseReader, type MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { REPUTATION_THRESHOLDS, REPUTATION_MIN_SAMPLE_SIZE } from '@owlat/shared/reputation';

// ============ RISK LEVEL THRESHOLDS ============

/**
 * Industry-standard thresholds for sending reputation, derived from the shared
 * single source of truth (`@owlat/shared/reputation`) so the backend's risk
 * classification and the web reputation UI can never diverge. Google and Yahoo
 * publish 0.3% as a complaint-rate ceiling; major ESPs warn at >2% bounce rate.
 */
const RISK_THRESHOLDS = {
	MIN_SAMPLE_SIZE: REPUTATION_MIN_SAMPLE_SIZE,
	COMPLAINT_MEDIUM: REPUTATION_THRESHOLDS.complaint.medium,
	COMPLAINT_HIGH: REPUTATION_THRESHOLDS.complaint.high,
	COMPLAINT_CRITICAL: REPUTATION_THRESHOLDS.complaint.critical,
	BOUNCE_MEDIUM: REPUTATION_THRESHOLDS.bounce.medium,
	BOUNCE_HIGH: REPUTATION_THRESHOLDS.bounce.high,
	BOUNCE_CRITICAL: REPUTATION_THRESHOLDS.bounce.critical,
} as const;

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * Calculate risk level from bounce and complaint rates.
 */
export function calculateRiskLevel(
	bounceRate: number,
	complaintRate: number,
	totalSent: number
): RiskLevel {
	// Not enough data to assess
	if (totalSent < RISK_THRESHOLDS.MIN_SAMPLE_SIZE) {
		return 'low';
	}

	// Critical: any critical threshold exceeded
	if (
		bounceRate >= RISK_THRESHOLDS.BOUNCE_CRITICAL ||
		complaintRate >= RISK_THRESHOLDS.COMPLAINT_CRITICAL
	) {
		return 'critical';
	}

	// High: any high threshold exceeded
	if (
		bounceRate >= RISK_THRESHOLDS.BOUNCE_HIGH ||
		complaintRate >= RISK_THRESHOLDS.COMPLAINT_HIGH
	) {
		return 'high';
	}

	// Medium: any medium threshold exceeded
	if (
		bounceRate >= RISK_THRESHOLDS.BOUNCE_MEDIUM ||
		complaintRate >= RISK_THRESHOLDS.COMPLAINT_MEDIUM
	) {
		return 'medium';
	}

	return 'low';
}

// ============ TYPES ============

type EventType = 'send' | 'deliver' | 'bounce' | 'hard_bounce' | 'complaint';

/** Which window a read/write targets. */
export type ReputationScope = { kind: 'org' } | { kind: 'domain'; domain: string };

/** Derived rolling-window view. Rate + risk are computed, never stored. */
export interface ReputationSummary {
	totalSent: number;
	totalDelivered: number;
	totalBounced: number;
	totalHardBounced: number;
	totalComplaints: number;
	bounceRate: number;
	complaintRate: number;
	riskLevel: RiskLevel;
}

export type ReputationBucket = Doc<'sendingReputation'>;
export type DomainReputationBucketGroups = ReadonlyMap<string, readonly ReputationBucket[]>;

const eventTypeValidator = v.union(
	v.literal('bounce'),
	v.literal('complaint'),
	v.literal('hard_bounce'),
	v.literal('send'),
	v.literal('deliver')
);

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 30 * DAY_MS; // rolling rate window
const RETENTION_MS = 60 * DAY_MS; // cleanup horizon

/**
 * Write-shard count per (scope, domain, day) bucket. Each event picks a random
 * shard and bumps only that row, so an N-recipient campaign spreads its
 * read-modify-writes across SHARD_COUNT daily rows instead of contending on a
 * single document (Convex OCC hotspot). `summarize` sums across all shards, so
 * the count is purely a write-side knob — raising it loosens contention,
 * lowering it shrinks the per-scope read set. 8 keeps the per-scope window at
 * ~60 days × 8 = ~480 rows, still a small bounded scan.
 */
const SHARD_COUNT = 8;

/** Start-of-day timestamp (midnight UTC) for a given time. */
export function startOfDayUtc(epochMs: number): number {
	const d = new Date(epochMs);
	d.setUTCHours(0, 0, 0, 0);
	return d.getTime();
}

// ============ READ-SIDE SEAM (the only window summarizer) ============

/**
 * Index query for one scope's day-buckets (all shards). `scope: 'org'` rows all
 * carry `domain: undefined`, so an `eq('scope', 'org')` prefix is exactly the
 * org window; a domain scope pins both `scope` and `domain`. `shardKey` trails
 * the prefix, so this returns every shard row for the scope across all days.
 */
function scopedBucketQuery(db: DatabaseReader, scope: ReputationScope) {
	return db
		.query('sendingReputation')
		.withIndex('by_scope_domain_period_shard', (q) =>
			scope.kind === 'org'
				? q.eq('scope', 'org')
				: q.eq('scope', 'domain').eq('domain', scope.domain)
		);
}

/** Sum the buckets inside the rolling window and derive rate + risk. */
function summarizeBuckets(buckets: readonly ReputationBucket[], cutoff: number): ReputationSummary {
	let totalSent = 0;
	let totalDelivered = 0;
	let totalBounced = 0;
	let totalHardBounced = 0;
	let totalComplaints = 0;

	for (const b of buckets) {
		if (b.periodStart < cutoff) continue; // outside the rolling window
		totalSent += b.totalSent;
		totalDelivered += b.totalDelivered;
		totalBounced += b.totalBounced;
		totalHardBounced += b.totalHardBounced;
		totalComplaints += b.totalComplaints;
	}

	const bounceRate = totalSent > 0 ? totalBounced / totalSent : 0;
	const complaintRate = totalSent > 0 ? totalComplaints / totalSent : 0;
	return {
		totalSent,
		totalDelivered,
		totalBounced,
		totalHardBounced,
		totalComplaints,
		bounceRate,
		complaintRate,
		riskLevel: calculateRiskLevel(bounceRate, complaintRate, totalSent),
	};
}

/**
 * The ONLY summarizer of the rolling window for a single scope. Reader-typed,
 * so the session shell, the platform-admin shell, the reporter, and the writer
 * all derive the identical number.
 */
export async function summarize(
	db: DatabaseReader,
	scope: ReputationScope
): Promise<ReputationSummary> {
	const cutoff = Date.now() - WINDOW_MS;
	// bounded: the cleanup cron prunes >60-day buckets, so one scope holds at
	// most ~60 days × SHARD_COUNT shard rows. Summing across shards here is what
	// makes the write-side shard split invisible to readers.
	const buckets = await scopedBucketQuery(db, scope).collect(); // bounded: one scope's ≤60-day × shard buckets (cron-pruned)
	return summarizeBuckets(buckets, cutoff);
}

/**
 * Grouped all-domains view for the per-domain dashboard. One loop over the
 * domain-scoped buckets, grouped by domain, each group run through the shared
 * `summarizeBuckets` core. Only domains with in-window activity appear.
 */
export async function readDomainReputationBucketGroups(
	db: DatabaseReader
): Promise<Map<string, ReputationBucket[]>> {
	// bounded: per-domain × ≤60 days × SHARD_COUNT shard rows, kept bounded by
	// the cleanup cron. Every domain dashboard metric consumes this one grouping.
	const buckets = await db
		.query('sendingReputation')
		.withIndex('by_scope_domain_period_shard', (q) => q.eq('scope', 'domain'))
		.collect(); // bounded: one scope's ≤60-day × shard buckets (cron-pruned)

	const byDomain = new Map<string, ReputationBucket[]>();
	for (const bucket of buckets) {
		if (!bucket.domain) continue; // defensive: domain-scoped rows always carry it
		const group = byDomain.get(bucket.domain);
		if (group) group.push(bucket);
		else byDomain.set(bucket.domain, [bucket]);
	}
	return byDomain;
}

export function summarizeDomainReputationGroups(
	groups: DomainReputationBucketGroups,
	now = Date.now()
): Array<ReputationSummary & { domain: string }> {
	const cutoff = now - WINDOW_MS;
	return [...groups.entries()]
		.filter(([, buckets]) => buckets.some((bucket) => bucket.periodStart >= cutoff))
		.map(([domain, buckets]) => ({
			domain,
			...summarizeBuckets(buckets, cutoff),
		}));
}

export async function summarizeDomains(
	db: DatabaseReader
): Promise<Array<ReputationSummary & { domain: string }>> {
	return summarizeDomainReputationGroups(await readDomainReputationBucketGroups(db));
}

// ============ WRITER ============

/** Per-event counter delta for a bucket. */
function countersFor(bucket: ReputationBucket, eventType: EventType): Partial<ReputationBucket> {
	switch (eventType) {
		case 'send':
			return { totalSent: bucket.totalSent + 1 };
		case 'deliver':
			return { totalDelivered: bucket.totalDelivered + 1 };
		case 'bounce':
			return { totalBounced: bucket.totalBounced + 1 };
		case 'hard_bounce':
			return {
				totalBounced: bucket.totalBounced + 1,
				totalHardBounced: bucket.totalHardBounced + 1,
			};
		case 'complaint':
			return { totalComplaints: bucket.totalComplaints + 1 };
	}
}

/**
 * Today's shard row for a scope, creating it on the first event that lands on
 * this (scope, domain, day, shard). The exact-prefix index lookup (all four
 * components pinned) makes this a point read, not a scan.
 */
async function todayShardBucket(
	ctx: MutationCtx,
	scope: ReputationScope,
	todayStart: number,
	shardKey: number,
	now: number
): Promise<ReputationBucket> {
	const existing = await ctx.db
		.query('sendingReputation')
		.withIndex('by_scope_domain_period_shard', (q) =>
			scope.kind === 'org'
				? q
						.eq('scope', 'org')
						.eq('domain', undefined)
						.eq('periodStart', todayStart)
						.eq('shardKey', shardKey)
				: q
						.eq('scope', 'domain')
						.eq('domain', scope.domain)
						.eq('periodStart', todayStart)
						.eq('shardKey', shardKey)
		)
		.unique();
	if (existing) return existing;

	const id = await ctx.db.insert('sendingReputation', {
		scope: scope.kind,
		...(scope.kind === 'domain' ? { domain: scope.domain } : {}),
		periodStart: todayStart,
		shardKey,
		totalSent: 0,
		totalDelivered: 0,
		totalBounced: 0,
		totalHardBounced: 0,
		totalComplaints: 0,
		lastCalculatedAt: now,
	});
	const created = await ctx.db.get(id);
	if (!created) throw new Error('Failed to create reputation bucket');
	return created;
}

/**
 * Increment one of today's shard rows for a scope by a single event. The shard
 * is chosen at random per call so concurrent events for the same (scope, day)
 * spread across SHARD_COUNT documents instead of contending on one — removing
 * the single-row OCC write hotspot. (Mutations may use Math.random; only the
 * workflow runtime forbids it.)
 */
async function bumpBucket(
	ctx: MutationCtx,
	scope: ReputationScope,
	eventType: EventType
): Promise<void> {
	const now = Date.now();
	const shardKey = Math.floor(Math.random() * SHARD_COUNT);
	const bucket = await todayShardBucket(ctx, scope, startOfDayUtc(now), shardKey, now);
	await ctx.db.patch(bucket._id, {
		...countersFor(bucket, eventType),
		lastCalculatedAt: now,
	});
}

/**
 * The only writer of `sendingReputation`. One event bumps a random shard of the
 * org window always and a random shard of the domain window when a sending
 * domain is present. Domain buckets feed the per-domain dashboard only — Abuse
 * status is a deployment-level state.
 *
 * This is the SEND-EVENT HOT PATH (scheduled per recipient by the Send
 * lifecycle's `reputation_update` effect), so it does the minimum: two point
 * read-modify-writes against sharded rows and nothing else. The risk
 * derivation + auto-enforce decision used to run inline here, `.collect()`-ing
 * the whole org window on every event — that wide read is now off the hot path,
 * moved to the hourly `evaluateAutoEnforce` step on the reputation cron (the
 * Abuse status module dedupes transitions idempotently, so deferring the
 * check from per-event to hourly preserves the enforce behavior — the
 * deliverability gate still trips, just on the cron cadence).
 */
export const recordEvent = internalMutation({
	args: {
		eventType: eventTypeValidator,
		// Optional sending domain for domain-level reputation tracking.
		domain: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await bumpBucket(ctx, { kind: 'org' }, args.eventType);
		if (args.domain) {
			await bumpBucket(ctx, { kind: 'domain', domain: args.domain }, args.eventType);
		}
	},
});

/**
 * The auto-enforce DECISION, off the hot path. Runs on the reputation cron:
 * summarizes the org window once and escalates the deployment's Abuse status
 * when the derived risk is `high`/`critical`. This is the one wide
 * `.collect()` of the org window per cron tick rather than per send-event —
 * the move that removes the read-amplification from `recordEvent`.
 *
 * The enforce decision lives only here (the per-event trigger that used to live
 * inline in `recordEvent` is gone). It still fires while the org window is
 * `high`/`critical`; the Abuse status module dedupes the transition
 * idempotently, so this remains a behavior-preserving refactor, not a new
 * enforce policy.
 */
export const evaluateAutoEnforce = internalMutation({
	args: {},
	handler: async (ctx) => {
		const org = await summarize(ctx.db, { kind: 'org' });
		if (org.riskLevel === 'high' || org.riskLevel === 'critical') {
			await ctx.scheduler.runAfter(0, internal.analytics.sendingReputation.autoEnforceReputation, {
				riskLevel: org.riskLevel,
			});
		}
		return { riskLevel: org.riskLevel };
	},
});

// ============ ENFORCE EXECUTOR ============

/**
 * Auto-enforce reputation-based restrictions.
 * - critical → auto-suspend
 * - high → auto-warn
 *
 * Per ADR-0011, the severity-ladder + banned-terminal logic lives in
 * the Abuse status (module); this caller picks the target status and
 * delegates. Severity downgrades (e.g., critical → warned) are refused
 * by the lifecycle, matching the prior pre-deepening behavior of
 * `setAbuseStatusInternal`. (Same-state attempts return `recorded`.)
 */
export const autoEnforceReputation = internalMutation({
	args: {
		riskLevel: v.union(v.literal('high'), v.literal('critical')),
	},
	handler: async (ctx, args) => {
		const target = args.riskLevel === 'critical' ? 'suspended' : 'warned';
		const reason =
			args.riskLevel === 'critical'
				? 'Auto-suspended: complaint rate or bounce rate exceeded critical thresholds'
				: 'Auto-warned: complaint rate or bounce rate exceeding safe thresholds';

		await ctx.runMutation(internal.workspaces.abuseStatus.transition, {
			input: {
				to: target,
				at: Date.now(),
				reason,
				changedBy: 'system',
			},
		});
	},
});

// ============ CLEANUP CRON ============

/**
 * Age out reputation buckets older than 60 days across BOTH scopes. Called
 * hourly by cron. Risk no longer needs periodic recalculation — it is derived
 * on read — so this is cleanup-only (closing the org/domain cleanup asymmetry:
 * the domain scope previously had no cron fallback and grew unbounded).
 */
export const recalculateAll = internalMutation({
	args: {},
	handler: async (ctx) => {
		const cutoff = Date.now() - RETENTION_MS;

		// bounded: hourly cleanup keeps each scope at ~60 days × SHARD_COUNT rows
		// (org) / per-domain × ~60 × SHARD_COUNT (domain), so a full per-scope
		// scan stays small.
		const orgBuckets = await ctx.db
			.query('sendingReputation')
			.withIndex('by_scope_domain_period_shard', (q) => q.eq('scope', 'org'))
			.collect(); // bounded: one scope's ≤60-day × shard buckets (cron-pruned)
		const domainBuckets = await ctx.db
			.query('sendingReputation')
			.withIndex('by_scope_domain_period_shard', (q) => q.eq('scope', 'domain'))
			.collect(); // bounded: one scope's ≤60-day × shard buckets (cron-pruned)

		for (const bucket of [...orgBuckets, ...domainBuckets]) {
			if (bucket.periodStart < cutoff) {
				await ctx.db.delete(bucket._id);
			}
		}
	},
});
