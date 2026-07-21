/**
 * Sending reputation (module) — integration tests.
 *
 * Drives delivery events through `recordEvent` and asserts the read-side
 * summarizer's rolling rate/risk per scope; asserts the org and domain windows
 * accumulate independently; asserts the auto-enforce path (the auto-suspend
 * that is the single most consequential behavior here, and was untested before
 * ADR-0042); and asserts the cleanup cron prunes >60-day buckets across both
 * scopes.
 *
 * See docs/adr/0042-sending-reputation-module.md.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { summarize, summarizeDomains } from '../analytics/sendingReputation';
import {
	SPAM_RATE_HARD_THRESHOLD,
	SPAM_RATE_TARGET,
	summarizeSpamRate,
} from '../analytics/spamRate';

vi.mock('../lib/contactCountHelpers', async () => {
	const actual = await vi.importActual('../lib/contactCountHelpers');
	return {
		...actual,
		incrementContactCount: vi.fn().mockResolvedValue(undefined),
		decrementContactCount: vi.fn().mockResolvedValue(undefined),
		getCachedContactCount: vi.fn().mockResolvedValue(0),
		reconcileContactCount: vi.fn().mockResolvedValue(undefined),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
			!path.includes('agent/walker') &&
			!path.includes('agent/steps/index') &&
			!path.includes('agent/steps/shared') &&
			!path.includes('agent/steps/classify') &&
			!path.includes('agent/steps/draft') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

const DAY_MS = 24 * 60 * 60 * 1000;
type Tester = ReturnType<typeof convexTest>;

function dayStart(epochMs: number): number {
	const d = new Date(epochMs);
	d.setUTCHours(0, 0, 0, 0);
	return d.getTime();
}

async function seedSettings(t: Tester, overrides: Record<string, unknown> = {}): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			contactCount: 0,
			createdAt: Date.now(),
			...overrides,
		});
	});
}

async function seedBucket(
	t: Tester,
	fields: {
		scope: 'org' | 'domain';
		domain?: string;
		periodStart: number;
		shardKey?: number;
		totalSent?: number;
		totalDelivered?: number;
		totalBounced?: number;
		totalHardBounced?: number;
		totalComplaints?: number;
	}
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('sendingReputation', {
			scope: fields.scope,
			...(fields.domain ? { domain: fields.domain } : {}),
			periodStart: fields.periodStart,
			shardKey: fields.shardKey ?? 0,
			totalSent: fields.totalSent ?? 0,
			totalDelivered: fields.totalDelivered ?? 0,
			totalBounced: fields.totalBounced ?? 0,
			totalHardBounced: fields.totalHardBounced ?? 0,
			totalComplaints: fields.totalComplaints ?? 0,
			lastCalculatedAt: Date.now(),
		});
	});
}

async function record(
	t: Tester,
	eventType: 'send' | 'deliver' | 'bounce' | 'hard_bounce' | 'complaint',
	domain?: string
): Promise<void> {
	await t.mutation(internal.analytics.sendingReputation.recordEvent, {
		eventType,
		...(domain ? { domain } : {}),
	});
}

describe('provider-facing FBL spam rate', () => {
	it('uses delivered volume and classifies the exact 0.1% / 0.3% boundaries', async () => {
		const now = dayStart(Date.now()) + 12 * 60 * 60 * 1000;
		const t = convexTest(schema, modules);
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(now),
			totalSent: 20_000,
			totalDelivered: 10_000,
			totalComplaints: 10,
		});
		const target = await t.run((ctx) => summarizeSpamRate(ctx.db, { kind: 'org' }, now));
		expect(target.spamRate).toBe(SPAM_RATE_TARGET);
		expect(target.status).toBe('elevated');

		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(now),
			shardKey: 1,
			totalDelivered: 0,
			totalComplaints: 20,
		});
		const hard = await t.run((ctx) => summarizeSpamRate(ctx.db, { kind: 'org' }, now));
		expect(hard.spamRate).toBe(SPAM_RATE_HARD_THRESHOLD);
		expect(hard.status).toBe('hard_limit');
	});

	it('requires seven completed active days strictly below 0.3% for recovery', async () => {
		const now = dayStart(Date.now()) + 12 * 60 * 60 * 1000;
		const t = convexTest(schema, modules);
		for (let daysAgo = 1; daysAgo <= 7; daysAgo++) {
			await seedBucket(t, {
				scope: 'org',
				periodStart: dayStart(now) - daysAgo * DAY_MS,
				totalDelivered: 1_000,
				totalComplaints: 2,
			});
		}
		const recovered = await t.run((ctx) => summarizeSpamRate(ctx.db, { kind: 'org' }, now));
		expect(recovered.cleanDaysBelowHardThreshold).toBe(7);
		expect(recovered.recoveryEligible).toBe(true);

		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(now) - 3 * DAY_MS,
			shardKey: 1,
			totalDelivered: 0,
			totalComplaints: 1,
		});
		const boundaryBreak = await t.run((ctx) => summarizeSpamRate(ctx.db, { kind: 'org' }, now));
		expect(boundaryBreak.cleanDaysBelowHardThreshold).toBe(2);
		expect(boundaryBreak.recoveryEligible).toBe(false);
	});
});

// ────────────────────────────────────────────────────────────────────
// recordEvent — accumulation per scope
// ────────────────────────────────────────────────────────────────────

describe('recordEvent — accumulation', () => {
	it('bumps the org window on every event and the domain window only on its own', async () => {
		const t = convexTest(schema, modules);

		await record(t, 'send'); // org only
		await record(t, 'send'); // org only
		await record(t, 'send', 'a.com'); // org + a.com
		await record(t, 'send', 'a.com'); // org + a.com
		await record(t, 'send', 'a.com'); // org + a.com
		await record(t, 'bounce', 'a.com'); // org + a.com
		await record(t, 'send', 'b.com'); // org + b.com

		const org = await t.run((ctx) => summarize(ctx.db, { kind: 'org' }));
		expect(org.totalSent).toBe(6); // 2 + 3 + 1
		expect(org.totalBounced).toBe(1);

		const a = await t.run((ctx) => summarize(ctx.db, { kind: 'domain', domain: 'a.com' }));
		expect(a.totalSent).toBe(3);
		expect(a.totalBounced).toBe(1);

		const b = await t.run((ctx) => summarize(ctx.db, { kind: 'domain', domain: 'b.com' }));
		expect(b.totalSent).toBe(1);
		expect(b.totalBounced).toBe(0);
	});

	it('hard_bounce increments both totalBounced and totalHardBounced', async () => {
		const t = convexTest(schema, modules);

		await record(t, 'hard_bounce');

		const org = await t.run((ctx) => summarize(ctx.db, { kind: 'org' }));
		expect(org.totalBounced).toBe(1);
		expect(org.totalHardBounced).toBe(1);
	});

	it('an event without a domain creates no domain-scoped buckets', async () => {
		const t = convexTest(schema, modules);

		await record(t, 'send');

		await t.run(async (ctx) => {
			const domainRows = await ctx.db
				.query('sendingReputation')
				.withIndex('by_scope_domain_period_shard', (q) => q.eq('scope', 'domain'))
				.collect();
			expect(domainRows).toHaveLength(0);
		});
	});

	// ── PR-72 regression-lock: hard_bounce vs bounce vs complaint distinction ──
	//
	// Reputation must distinguish the three failure event types: a soft `bounce`
	// and a `hard_bounce` both count toward totalBounced (→ bounceRate), but only
	// hard_bounce also advances totalHardBounced; a `complaint` counts ONLY toward
	// totalComplaints (→ complaintRate) and never toward bounces. The risk
	// thresholds then read those separate rates. See
	// EMAIL_BEST_PRACTICES_AUDIT_2026-06-21.md "PR-72".
	it('keeps soft bounce, hard bounce and complaint on separate counters', async () => {
		const t = convexTest(schema, modules);

		await record(t, 'bounce'); // soft bounce — totalBounced only
		await record(t, 'hard_bounce'); // hard bounce — totalBounced + totalHardBounced
		await record(t, 'complaint'); // complaint — totalComplaints only

		const org = await t.run((ctx) => summarize(ctx.db, { kind: 'org' }));
		expect(org.totalBounced).toBe(2); // soft + hard
		expect(org.totalHardBounced).toBe(1); // hard only
		expect(org.totalComplaints).toBe(1); // complaint only — not a bounce
	});
});

// ────────────────────────────────────────────────────────────────────
// PR-72 regression-lock: complaint rate independently drives risk
//
// The Gmail/Yahoo 2024 sender rule is a hard >0.3% complaint-rate ceiling. A
// window with a zero bounce rate but a complaint rate at/above 0.3% must still
// derive `critical` — the complaint dimension drives risk on its own. This locks
// that summarize() routes totalComplaints into complaintRate and that
// calculateRiskLevel trips critical off complaints alone.
// ────────────────────────────────────────────────────────────────────

describe('summarize — complaint rate drives risk independently (PR-72)', () => {
	it('a 0.3% complaint rate with zero bounces derives critical', async () => {
		const t = convexTest(schema, modules);
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(Date.now()),
			totalSent: 1000,
			totalBounced: 0,
			totalComplaints: 3, // 0.3% → Gmail/Yahoo critical ceiling
		});

		const org = await t.run((ctx) => summarize(ctx.db, { kind: 'org' }));
		expect(org.bounceRate).toBe(0);
		expect(org.complaintRate).toBeCloseTo(0.003, 6);
		expect(org.riskLevel).toBe('critical');
	});
});

// ────────────────────────────────────────────────────────────────────
// sharding (FIX 3a-1) — recordEvent spreads writes across shard rows;
// summarize sums across all of them back to the exact pre-shard total.
// ────────────────────────────────────────────────────────────────────

describe('sharded writes — summarize sums across shards', () => {
	it('summarize across shards equals the total after recording many events', async () => {
		const t = convexTest(schema, modules);

		const SENDS = 200;
		const BOUNCES = 25;
		const COMPLAINTS = 3;
		for (let i = 0; i < SENDS; i++) await record(t, 'send');
		for (let i = 0; i < BOUNCES; i++) await record(t, 'bounce');
		for (let i = 0; i < COMPLAINTS; i++) await record(t, 'complaint');

		// The window summarizer must recover the exact pre-shard totals, summing
		// across however many shard rows the random writes landed on.
		const org = await t.run((ctx) => summarize(ctx.db, { kind: 'org' }));
		expect(org.totalSent).toBe(SENDS);
		expect(org.totalBounced).toBe(BOUNCES);
		expect(org.totalComplaints).toBe(COMPLAINTS);
		expect(org.bounceRate).toBeCloseTo(BOUNCES / SENDS, 6);
		expect(org.complaintRate).toBeCloseTo(COMPLAINTS / SENDS, 6);

		// And the writes actually fanned out — well above one daily row — which is
		// the whole point of the shard split (removes the single-doc OCC hotspot).
		const rows = await t.run(async (ctx) =>
			ctx.db
				.query('sendingReputation')
				.withIndex('by_scope_domain_period_shard', (q) => q.eq('scope', 'org'))
				.collect()
		);
		const distinctShards = new Set(rows.map((r) => r.shardKey));
		expect(distinctShards.size).toBeGreaterThan(1);
		// Per-shard counters add back up to the grand total (no double count).
		const summed = rows.reduce(
			(acc, r) => ({
				sent: acc.sent + r.totalSent,
				bounced: acc.bounced + r.totalBounced,
				complaints: acc.complaints + r.totalComplaints,
			}),
			{ sent: 0, bounced: 0, complaints: 0 }
		);
		expect(summed).toEqual({ sent: SENDS, bounced: BOUNCES, complaints: COMPLAINTS });
	});

	it('summarize sums hand-seeded shards of the same (scope, day) bucket', async () => {
		const t = convexTest(schema, modules);
		const today = dayStart(Date.now());
		// Three explicit shards of the same org day-bucket.
		await seedBucket(t, {
			scope: 'org',
			periodStart: today,
			shardKey: 0,
			totalSent: 400,
			totalBounced: 4,
		});
		await seedBucket(t, {
			scope: 'org',
			periodStart: today,
			shardKey: 3,
			totalSent: 350,
			totalBounced: 6,
		});
		await seedBucket(t, {
			scope: 'org',
			periodStart: today,
			shardKey: 7,
			totalSent: 250,
			totalBounced: 0,
		});

		const org = await t.run((ctx) => summarize(ctx.db, { kind: 'org' }));
		expect(org.totalSent).toBe(1000);
		expect(org.totalBounced).toBe(10);
		expect(org.bounceRate).toBeCloseTo(0.01, 6);
	});
});

// ────────────────────────────────────────────────────────────────────
// summarize — rolling rate + risk derivation
// ────────────────────────────────────────────────────────────────────

describe('summarize — derive on read', () => {
	it('derives bounce/complaint rate and risk from in-window buckets', async () => {
		const t = convexTest(schema, modules);
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(Date.now()),
			totalSent: 1000,
			totalBounced: 100,
		});

		const org = await t.run((ctx) => summarize(ctx.db, { kind: 'org' }));
		expect(org.bounceRate).toBeCloseTo(0.1, 5);
		expect(org.complaintRate).toBe(0);
		expect(org.riskLevel).toBe('critical'); // bounce >= 10%
	});

	it('excludes buckets older than the 30-day window', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		// Recent, healthy bucket.
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(now),
			totalSent: 200,
			totalBounced: 0,
		});
		// Old, catastrophic bucket — must NOT count.
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(now - 31 * DAY_MS),
			totalSent: 1000,
			totalBounced: 900,
		});

		const org = await t.run((ctx) => summarize(ctx.db, { kind: 'org' }));
		expect(org.totalSent).toBe(200);
		expect(org.bounceRate).toBe(0);
		expect(org.riskLevel).toBe('low');
	});

	it('returns low/zero for an empty scope', async () => {
		const t = convexTest(schema, modules);
		const org = await t.run((ctx) => summarize(ctx.db, { kind: 'org' }));
		expect(org.totalSent).toBe(0);
		expect(org.bounceRate).toBe(0);
		expect(org.riskLevel).toBe('low');
	});

	it('derives risk per scope — a noisy domain does not lift the org window', async () => {
		const t = convexTest(schema, modules);
		const today = dayStart(Date.now());
		await seedBucket(t, { scope: 'org', periodStart: today, totalSent: 1000, totalBounced: 0 });
		await seedBucket(t, {
			scope: 'domain',
			domain: 'bad.com',
			periodStart: today,
			totalSent: 1000,
			totalBounced: 200,
		});

		const org = await t.run((ctx) => summarize(ctx.db, { kind: 'org' }));
		const bad = await t.run((ctx) => summarize(ctx.db, { kind: 'domain', domain: 'bad.com' }));
		expect(org.riskLevel).toBe('low');
		expect(bad.riskLevel).toBe('critical');
	});

	it('summarizeDomains groups by domain and omits domains with no in-window activity', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const today = dayStart(now);
		await seedBucket(t, {
			scope: 'domain',
			domain: 'a.com',
			periodStart: today,
			totalSent: 500,
			totalBounced: 5,
		});
		await seedBucket(t, {
			scope: 'domain',
			domain: 'a.com',
			periodStart: dayStart(now - DAY_MS),
			totalSent: 500,
			totalBounced: 5,
		});
		// Only an out-of-window bucket → excluded entirely.
		await seedBucket(t, {
			scope: 'domain',
			domain: 'stale.com',
			periodStart: dayStart(now - 40 * DAY_MS),
			totalSent: 999,
			totalBounced: 0,
		});

		const domains = await t.run((ctx) => summarizeDomains(ctx.db));
		expect(domains.map((d) => d.domain).sort()).toEqual(['a.com']);
		const a = domains.find((d) => d.domain === 'a.com')!;
		expect(a.totalSent).toBe(1000); // both in-window buckets summed
		expect(a.totalBounced).toBe(10);
	});
});

// ────────────────────────────────────────────────────────────────────
// recordEvent — stays OFF the wide-read / enforce path (FIX 3a-1)
//
// The auto-enforce decision used to run inline on every recordEvent, summarizing
// the whole org window per send-event. It now lives on the hourly
// `evaluateAutoEnforce` cron step. recordEvent must therefore NOT schedule the
// enforce mutation, no matter how bad the org window already is.
// ────────────────────────────────────────────────────────────────────

async function pendingEnforceJobs(t: Tester): Promise<Array<{ riskLevel?: string }>> {
	return await t.run(async (ctx) => {
		const jobs = await ctx.db.system.query('_scheduled_functions').collect();
		return jobs
			.filter((j) => j.name.includes('autoEnforceReputation'))
			.map((j) => (j.args[0] ?? {}) as { riskLevel?: string });
	});
}

describe('recordEvent — off the enforce hot path', () => {
	it('does NOT schedule autoEnforceReputation even at a critical org window', async () => {
		const t = convexTest(schema, modules);
		// Today's org bucket already at the critical bounce rate (10%).
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(Date.now()),
			totalSent: 1000,
			totalBounced: 100,
		});

		await record(t, 'deliver'); // hot path: bump only, no summarize/enforce

		// The wide org-window summarize + enforce no longer happens per event.
		expect(await pendingEnforceJobs(t)).toHaveLength(0);
	});
});

// ────────────────────────────────────────────────────────────────────
// evaluateAutoEnforce — the enforce DECISION, moved to the cron path
//
// evaluateAutoEnforce schedules `autoEnforceReputation` via runAfter(0).
// convex-test @0.0.50 doesn't reliably run runAfter(0) jobs (the same chaining
// quirk the organization-deletion walker test documents), so we assert
// deterministically on the pending `_scheduled_functions` entry it enqueued —
// and cover the executor's effect separately below.
// ────────────────────────────────────────────────────────────────────

async function evaluate(t: Tester): Promise<{ riskLevel: string }> {
	return await t.mutation(internal.analytics.sendingReputation.evaluateAutoEnforce, {});
}

describe('evaluateAutoEnforce — enforce decision', () => {
	it('crossing critical enqueues an enforce with riskLevel critical', async () => {
		const t = convexTest(schema, modules);
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(Date.now()),
			totalSent: 1000,
			totalBounced: 100, // 10% → critical
		});

		const result = await evaluate(t);
		expect(result.riskLevel).toBe('critical');

		const jobs = await pendingEnforceJobs(t);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]?.riskLevel).toBe('critical');
	});

	it('high risk enqueues an enforce with riskLevel high', async () => {
		const t = convexTest(schema, modules);
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(Date.now()),
			totalSent: 1000,
			totalBounced: 60, // 6% → high
		});

		const result = await evaluate(t);
		expect(result.riskLevel).toBe('high');

		const jobs = await pendingEnforceJobs(t);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]?.riskLevel).toBe('high');
	});

	it('low risk enqueues no enforce', async () => {
		const t = convexTest(schema, modules);
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(Date.now()),
			totalSent: 1000,
			totalBounced: 10, // 1% → low
		});

		const result = await evaluate(t);
		expect(result.riskLevel).toBe('low');

		expect(await pendingEnforceJobs(t)).toHaveLength(0);
	});

	it('decides off the ORG window only — a critical domain does not enqueue', async () => {
		const t = convexTest(schema, modules);
		// Healthy org window; a noisy domain bucket must not lift it.
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(Date.now()),
			totalSent: 1000,
			totalBounced: 0,
		});
		await seedBucket(t, {
			scope: 'domain',
			domain: 'bad.com',
			periodStart: dayStart(Date.now()),
			totalSent: 1000,
			totalBounced: 200,
		});

		const result = await evaluate(t);
		expect(result.riskLevel).toBe('low');

		expect(await pendingEnforceJobs(t)).toHaveLength(0);
	});
});

// ────────────────────────────────────────────────────────────────────
// autoEnforceReputation — the enforce EXECUTOR (the auto-suspend path)
// ────────────────────────────────────────────────────────────────────

describe('autoEnforceReputation — executor', () => {
	it('critical → org is auto-suspended (delegates to Abuse status)', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t); // abuseStatus defaults to clean

		await t.mutation(internal.analytics.sendingReputation.autoEnforceReputation, {
			riskLevel: 'critical',
		});

		await t.run(async (ctx) => {
			const s = await ctx.db.query('instanceSettings').first();
			expect(s?.abuseStatus).toBe('suspended');
		});
	});

	it('high → org is auto-warned', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);

		await t.mutation(internal.analytics.sendingReputation.autoEnforceReputation, {
			riskLevel: 'high',
		});

		await t.run(async (ctx) => {
			const s = await ctx.db.query('instanceSettings').first();
			expect(s?.abuseStatus).toBe('warned');
		});
	});
});

// ────────────────────────────────────────────────────────────────────
// recalculateAll — cleanup cron
// ────────────────────────────────────────────────────────────────────

describe('recalculateAll — cleanup', () => {
	it('prunes >60-day buckets across both scopes and keeps recent ones', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const old = dayStart(now - 61 * DAY_MS);
		const recent = dayStart(now);

		await seedBucket(t, { scope: 'org', periodStart: old, totalSent: 5 });
		await seedBucket(t, { scope: 'org', periodStart: recent, totalSent: 7 });
		await seedBucket(t, { scope: 'domain', domain: 'a.com', periodStart: old, totalSent: 3 });
		await seedBucket(t, { scope: 'domain', domain: 'a.com', periodStart: recent, totalSent: 4 });

		await t.mutation(internal.analytics.sendingReputation.recalculateAll, {});

		await t.run(async (ctx) => {
			const rows = await ctx.db.query('sendingReputation').collect();
			expect(rows).toHaveLength(2);
			expect(rows.every((r) => r.periodStart === recent)).toBe(true);
			// Both scopes survive at the recent bucket.
			expect(rows.map((r) => r.scope).sort()).toEqual(['domain', 'org']);
		});
	});
});
