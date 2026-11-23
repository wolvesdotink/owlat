/**
 * Sending reputation (module) — integration tests.
 *
 * Drives delivery events through `recordEvent` and asserts the read-side
 * summarizer's rolling rate/risk per scope; asserts the org and domain windows
 * accumulate independently; asserts the auto-enforce path (the auto-suspend
 * that is the single most consequential behavior here, and was untested before
 * this module); and asserts the cleanup cron prunes >60-day buckets across both
 * scopes.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { newBetterAuthHarness } from './testModules';
import { _resetSingletonOrgCacheForTests } from '../lib/sessionOrganization';
import { components, internal } from '../_generated/api';
import { summarize, summarizeDomains } from '../analytics/sendingReputation';
import { readSuspensionLift } from '../analytics/reputationEvidence';
import {
	SPAM_RATE_HARD_THRESHOLD,
	SPAM_RATE_TARGET,
	summarizeSpamRate,
} from '../analytics/spamRate';
import { createTestDomain } from './factories';

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
			!path.includes('files/processing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A status change that stops or resumes sending notifies owners and admins,
 * and that fan-out reads the organization, so the harness has one like any
 * install.
 */
async function harness() {
	_resetSingletonOrgCacheForTests();
	const t = newBetterAuthHarness(modules);
	await t.mutation(components.betterAuth.adapter.create, {
		input: { model: 'organization', data: { name: 'Acme', slug: 'acme', createdAt: 1 } },
	} as never);
	return t;
}
const HOUR_MS = 60 * 60 * 1000;
type Tester = Awaited<ReturnType<typeof harness>>;

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
		const t = await harness();
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
		const t = await harness();
		for (let daysAgo = 1; daysAgo <= 7; daysAgo++) {
			await seedBucket(t, {
				scope: 'org',
				periodStart: dayStart(now) - daysAgo * DAY_MS,
				totalDelivered: 1_000,
				totalComplaints: 2,
			});
		}
		const recovered = await t.run((ctx) => summarizeSpamRate(ctx.db, { kind: 'org' }, now));
		expect(recovered.cleanInternalDaysBelowHardThreshold).toBe(7);
		expect(recovered.hasRequiredInternalCleanDayEvidence).toBe(true);

		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(now) - 3 * DAY_MS,
			shardKey: 1,
			totalDelivered: 0,
			totalComplaints: 1,
		});
		const boundaryBreak = await t.run((ctx) => summarizeSpamRate(ctx.db, { kind: 'org' }, now));
		expect(boundaryBreak.cleanInternalDaysBelowHardThreshold).toBe(2);
		expect(boundaryBreak.hasRequiredInternalCleanDayEvidence).toBe(false);
	});
});

// ────────────────────────────────────────────────────────────────────
// recordEvent — accumulation per scope
// ────────────────────────────────────────────────────────────────────

describe('recordEvent — accumulation', () => {
	it('bumps the org window on every event and the domain window only on its own', async () => {
		const t = await harness();

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
		const t = await harness();

		await record(t, 'hard_bounce');

		const org = await t.run((ctx) => summarize(ctx.db, { kind: 'org' }));
		expect(org.totalBounced).toBe(1);
		expect(org.totalHardBounced).toBe(1);
	});

	it('an event without a domain creates no domain-scoped buckets', async () => {
		const t = await harness();

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
		const t = await harness();

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
		const t = await harness();
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
		const t = await harness();

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
		const t = await harness();
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
		const t = await harness();
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
		const t = await harness();
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
		const t = await harness();
		const org = await t.run((ctx) => summarize(ctx.db, { kind: 'org' }));
		expect(org.totalSent).toBe(0);
		expect(org.bounceRate).toBe(0);
		expect(org.riskLevel).toBe('low');
	});

	it('derives risk per scope — a noisy domain does not lift the org window', async () => {
		const t = await harness();
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
		const t = await harness();
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
// recordEvent — stays OFF the wide-read / enforce path
//
// The auto-enforce decision summarizes the whole org window, too wide a read
// for every send-event, so it lives on the hourly `evaluateAutoEnforce` cron
// step. recordEvent must therefore NOT schedule the enforce mutation, no matter
// how bad the org window already is.
// ────────────────────────────────────────────────────────────────────

async function pendingEnforceJobs(t: Tester): Promise<Array<{ riskLevel?: string }>> {
	return await t.run(async (ctx) => {
		const jobs = await ctx.db.system.query('_scheduled_functions').collect();
		return jobs
			.filter((j) => j.name.includes('autoEnforceReputation'))
			.map((j) => (j.args[0] ?? {}) as { riskLevel?: string });
	});
}

/** The status the hourly check left, with the trigger it stored. */
async function abuseState(t: Tester) {
	return await t.run(async (ctx) => {
		const settings = await ctx.db.query('instanceSettings').first();
		return {
			status: settings?.abuseStatus,
			trigger: settings?.abuseStatusTrigger,
			reason: settings?.abuseStatusReason,
		};
	});
}

describe('recordEvent — off the enforce hot path', () => {
	it('does NOT schedule autoEnforceReputation even at a critical org window', async () => {
		const t = await harness();
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
// evaluateAutoEnforce applies its decision in the same mutation that read the
// evidence and the hold, so the tests read the status it left.
// ────────────────────────────────────────────────────────────────────

async function evaluate(t: Tester): Promise<{ riskLevel: string }> {
	return await t.mutation(internal.analytics.reputationCheck.evaluateAutoEnforce, {});
}

describe('evaluateAutoEnforce — enforce decision', () => {
	it('crossing critical suspends', async () => {
		const t = await harness();
		await seedSettings(t);
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(Date.now()),
			totalSent: 1000,
			totalBounced: 100, // 10% → critical
		});

		const result = await evaluate(t);
		expect(result.riskLevel).toBe('critical');

		expect(await abuseState(t)).toMatchObject({
			status: 'suspended',
			trigger: { code: 'bounce_rate' },
		});
		expect(await pendingEnforceJobs(t)).toHaveLength(0);
	});

	it('high risk warns', async () => {
		const t = await harness();
		await seedSettings(t);
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(Date.now()),
			totalSent: 1000,
			totalBounced: 60, // 6% → high
		});

		const result = await evaluate(t);
		expect(result.riskLevel).toBe('high');

		expect((await abuseState(t)).status).toBe('warned');
	});

	it('low risk changes nothing', async () => {
		const t = await harness();
		await seedSettings(t);
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(Date.now()),
			totalSent: 1000,
			totalBounced: 10, // 1% → low
		});

		const result = await evaluate(t);
		expect(result.riskLevel).toBe('low');

		expect((await abuseState(t)).status).toBeUndefined();
	});

	it('decides off the ORG window only — a critical domain does not enforce', async () => {
		const t = await harness();
		await seedSettings(t);
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

		expect((await abuseState(t)).status).toBeUndefined();
	});
});

// Gmail sends no ARF reports, so a Gmail spam-rate breach only shows in Google
// Postmaster Tools. A fresh Postmaster reading feeds the same decision the
// internal complaint rate feeds; stale data never enforces anything.
describe('evaluateAutoEnforce — Gmail spam rate from Postmaster', () => {
	async function seedPostmaster(
		t: Tester,
		fields: { ratio: number; fetchedAgoMs: number; periodAgoMs?: number }
	): Promise<void> {
		const now = Date.now();
		await t.run(async (ctx) => {
			const domainId = await ctx.db.insert(
				'domains',
				createTestDomain({ domain: 'news.example.com', status: 'verified' })
			);
			await ctx.db.insert('googlePostmasterStats', {
				domainId,
				domain: 'news.example.com',
				periodStart: dayStart(now - (fields.periodAgoMs ?? DAY_MS)),
				userReportedSpamRatio: fields.ratio,
				fetchedAt: now - fields.fetchedAgoMs,
				ingestedAt: now - fields.fetchedAgoMs,
			});
		});
	}

	it('suspends at the hard line and names Gmail as the source', async () => {
		const t = await harness();
		await seedSettings(t);
		await seedPostmaster(t, { ratio: 0.0042, fetchedAgoMs: 2 * 60 * 60 * 1000 });

		await evaluate(t);
		const { status, reason } = await abuseState(t);

		expect(status).toBe('suspended');
		expect(reason).toContain('Gmail reports a spam rate of 0.42%');
		expect(reason).toContain('news.example.com');
	});

	it('warns between Google’s guidance and the hard line', async () => {
		const t = await harness();
		await seedSettings(t);
		await seedPostmaster(t, { ratio: 0.0015, fetchedAgoMs: 2 * 60 * 60 * 1000 });

		await evaluate(t);
		const { status, reason } = await abuseState(t);

		expect(status).toBe('warned');
		expect(reason).toContain('Gmail reports a spam rate of 0.15%');
	});

	it.each([
		['fetched too long ago', { fetchedAgoMs: 3 * DAY_MS }],
		['describing a day too long ago', { fetchedAgoMs: 60 * 60 * 1000, periodAgoMs: 6 * DAY_MS }],
	])('never enforces on Postmaster data %s', async (_label, age) => {
		const t = await harness();
		await seedSettings(t);
		await seedPostmaster(t, { ratio: 0.009, ...age });

		await evaluate(t);

		expect((await abuseState(t)).status).toBeUndefined();
	});
});

// ────────────────────────────────────────────────────────────────────
// autoEnforceReputation — the enforce EXECUTOR (the auto-suspend path)
// ────────────────────────────────────────────────────────────────────

describe('autoEnforceReputation — a job an older release queued', () => {
	afterEach(() => vi.useRealTimers());

	it('decides afresh instead of applying its old verdict', async () => {
		const t = await harness();
		await seedSettings(t);

		await t.mutation(internal.analytics.sendingReputation.autoEnforceReputation, {
			riskLevel: 'critical',
		});

		expect((await abuseState(t)).status).toBeUndefined();
	});

	it('respects the hold of a lift made after it was queued', async () => {
		const now = Date.UTC(2026, 10, 20, 12);
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const t = await harness();
		await seedSettings(t, { abuseStatus: 'suspended', abuseStatusChangedBy: 'system' });
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(now),
			totalSent: 1000,
			totalBounced: 120,
		});
		await t.mutation(internal.workspaces.abuseStatus.adminOverride, {
			input: { to: 'clean', at: now, reason: 'list cleaned', changedBy: 'admin-1' },
		});

		await t.mutation(internal.analytics.sendingReputation.autoEnforceReputation, {
			riskLevel: 'critical',
		});

		expect((await abuseState(t)).status).toBe('clean');
	});
});

// ────────────────────────────────────────────────────────────────────
// recalculateAll — cleanup cron
// ────────────────────────────────────────────────────────────────────

describe('recalculateAll — cleanup', () => {
	it('prunes >60-day buckets across both scopes and keeps recent ones', async () => {
		const t = await harness();
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

// ────────────────────────────────────────────────────────────────────
// Automatic resume, and a manual lift that holds
// ────────────────────────────────────────────────────────────────────

describe('evaluateAutoEnforce — automatic resume', () => {
	const NOW = Date.UTC(2026, 10, 20, 12);
	afterEach(() => vi.useRealTimers());

	async function settingsRow(t: Tester) {
		return await t.run(async (ctx) => await ctx.db.query('instanceSettings').first());
	}

	async function resumeNotices(t: Tester): Promise<string[]> {
		return await t.run(async (ctx) => {
			const jobs = await ctx.db.system.query('_scheduled_functions').collect();
			return jobs
				.filter((j) => j.name.includes('fanOut'))
				.map((j) => (j.args[0] as { event: { kind: string } }).event.kind);
		});
	}

	const systemSuspension = {
		abuseStatus: 'suspended',
		abuseStatusReason: 'Auto-suspended: complaint rate or bounce rate exceeded critical thresholds',
		abuseStatusChangedAt: NOW - DAY_MS,
		abuseStatusChangedBy: 'system',
		abuseStatusTrigger: { code: 'bounce_rate' },
	};

	it('lifts a suspension the check imposed once the rate is under the clear line, not before', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const t = await harness();
		await seedSettings(t, systemSuspension);
		// 7%: under the 10% that suspends, still over the 5% that clears it.
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(NOW),
			totalSent: 1000,
			totalBounced: 70,
		});

		await evaluate(t);
		expect((await settingsRow(t))?.abuseStatus).toBe('suspended');

		// Another 1000 clean sends bring the window to 3.5%.
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(NOW),
			shardKey: 1,
			totalSent: 1000,
		});
		await evaluate(t);

		const row = await settingsRow(t);
		expect(row?.abuseStatus).toBe('clean');
		expect(row?.abuseStatusTrigger).toBeUndefined();
		const audit = await t.run(async (ctx) =>
			(await ctx.db.query('auditLogs').collect()).filter(
				(l) => l.action === 'abuse_status_changed' && l.details?.['newStatus'] === 'clean'
			)
		);
		expect(audit).toHaveLength(1);
		expect(audit[0]?.userId).toBe('system');
		expect(audit[0]?.details?.['trigger']).toBe('bounce_rate');
		expect(await resumeNotices(t)).toContain('sending_resumed');
	});

	it('keeps its trigger while that trigger is still over the clear line, whatever else crosses', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const t = await harness();
		await seedSettings(t, systemSuspension);
		// Bounces 7% (not cleared), complaints 0.4% (over the suspension line).
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(NOW),
			totalSent: 1000,
			totalBounced: 70,
			totalComplaints: 4,
		});

		await evaluate(t);

		expect((await settingsRow(t))?.abuseStatusTrigger).toEqual({ code: 'bounce_rate' });
	});

	it('describes the metric that keeps sending suspended once the stored one has cleared', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const t = await harness();
		await seedSettings(t, systemSuspension);
		// Bounces 1% (cleared), complaints 0.4% (over the suspension line).
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(NOW),
			totalSent: 1000,
			totalBounced: 10,
			totalComplaints: 4,
		});

		const lift = await t.run(async (ctx) =>
			readSuspensionLift(ctx.db, await ctx.db.query('instanceSettings').first(), NOW)
		);

		expect(lift).toMatchObject({ mode: 'automatic', code: 'complaint_rate', isClear: false });
	});

	it('lifts once the evidence has aged out of the window', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const t = await harness();
		await seedSettings(t, systemSuspension);
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(NOW - 31 * DAY_MS),
			totalSent: 1000,
			totalBounced: 200,
		});

		await evaluate(t);

		expect((await settingsRow(t))?.abuseStatus).toBe('clean');
	});

	it('does not lift when the instance requires a platform admin to lift it', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const t = await harness();
		await seedSettings(t, { ...systemSuspension, isSendingResumeManual: true });
		await seedBucket(t, { scope: 'org', periodStart: dayStart(NOW), totalSent: 1000 });

		await evaluate(t);

		expect((await settingsRow(t))?.abuseStatus).toBe('suspended');
	});

	it.each([
		[
			'a suspension a platform admin imposed',
			{ abuseStatus: 'suspended', abuseStatusChangedBy: 'admin-1', abuseStatusReason: 'spam' },
		],
		[
			'a ban, even one the check stored a trigger for',
			{ ...systemSuspension, abuseStatus: 'banned' },
		],
		[
			'a legacy auto-suspension with no stored trigger',
			{
				abuseStatus: 'suspended',
				abuseStatusChangedBy: 'system',
				abuseStatusReason: systemSuspension.abuseStatusReason,
			},
		],
	])('never lifts %s', async (_label, row) => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const t = await harness();
		await seedSettings(t, row);
		await seedBucket(t, { scope: 'org', periodStart: dayStart(NOW), totalSent: 1000 });

		await evaluate(t);

		expect((await settingsRow(t))?.abuseStatus).toBe(row.abuseStatus);
	});

	it('a Gmail suspension lifts only once no reading in the window is over Google’s guidance', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const t = await harness();
		await seedSettings(t, {
			...systemSuspension,
			abuseStatusTrigger: { code: 'gmail_spam_rate', domain: 'news.example.com' },
		});
		await t.run(async (ctx) => {
			const domainId = await ctx.db.insert(
				'domains',
				createTestDomain({ domain: 'news.example.com', status: 'verified' })
			);
			await ctx.db.insert('googlePostmasterStats', {
				domainId,
				domain: 'news.example.com',
				periodStart: dayStart(NOW - 10 * DAY_MS),
				userReportedSpamRatio: 0.004,
				fetchedAt: NOW - 9 * DAY_MS,
				ingestedAt: NOW - 9 * DAY_MS,
			});
		});

		// Too old to enforce, still inside the 30-day window.
		await evaluate(t);
		expect((await settingsRow(t))?.abuseStatus).toBe('suspended');

		vi.setSystemTime(NOW + 21 * DAY_MS);
		await evaluate(t);
		expect((await settingsRow(t))?.abuseStatus).toBe('clean');
	});
});

describe('evaluateAutoEnforce — a manual lift holds', () => {
	const NOW = Date.UTC(2026, 10, 20, 12);
	afterEach(() => vi.useRealTimers());

	async function liftByAdmin(t: Tester) {
		return await t.mutation(internal.workspaces.abuseStatus.adminOverride, {
			input: { to: 'clean', at: Date.now(), reason: 'list cleaned', changedBy: 'admin-1' },
		});
	}

	it('does not suspend again on the evidence known at the lift until the hold ends', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const t = await harness();
		await seedSettings(t, { abuseStatus: 'suspended', abuseStatusChangedBy: 'system' });
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(NOW),
			totalSent: 1000,
			totalBounced: 120,
		});

		const outcome = await liftByAdmin(t);

		vi.setSystemTime(NOW + HOUR_MS);
		await evaluate(t);
		expect((await abuseState(t)).status).toBe('clean');
		expect(outcome).toMatchObject({
			ok: true,
			hold: { until: NOW + 7 * DAY_MS, triggers: [{ code: 'bounce_rate' }] },
		});

		vi.setSystemTime(NOW + 7 * DAY_MS + HOUR_MS);
		await evaluate(t);
		expect(await abuseState(t)).toMatchObject({
			status: 'suspended',
			trigger: { code: 'bounce_rate' },
		});
	});

	it('a later lift with nothing over the line ends the earlier hold', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const t = await harness();
		await seedSettings(t, { abuseStatus: 'suspended', abuseStatusChangedBy: 'system' });
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(NOW),
			totalSent: 1000,
			totalBounced: 120,
		});
		await liftByAdmin(t);
		await t.mutation(internal.workspaces.abuseStatus.adminOverride, {
			input: { to: 'suspended', at: NOW + 1, reason: 'again', changedBy: 'admin-1' },
		});
		// The bounces are cleaned up before the second lift.
		await t.run(async (ctx) => {
			for (const row of await ctx.db.query('sendingReputation').collect()) {
				await ctx.db.delete(row._id);
			}
		});
		vi.setSystemTime(NOW + 2);
		await liftByAdmin(t);

		const row = await t.run(async (ctx) => await ctx.db.query('instanceSettings').first());
		expect(row?.reputationCheckHold).toBeUndefined();
	});

	it('a warning on another metric during the hold does not end the hold', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const t = await harness();
		await seedSettings(t, { abuseStatus: 'suspended', abuseStatusChangedBy: 'system' });
		// Complaints at 0.2%: on the warning line, so the warning stays.
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(NOW),
			totalSent: 1000,
			totalBounced: 120,
			totalComplaints: 2,
		});
		await liftByAdmin(t);
		await t.mutation(internal.workspaces.abuseStatus.transition, {
			input: {
				to: 'warned',
				at: NOW + 1,
				reason: 'Auto-warned: complaints',
				changedBy: 'system',
				trigger: { code: 'complaint_rate' },
			},
		});

		vi.setSystemTime(NOW + HOUR_MS);
		await evaluate(t);

		expect((await abuseState(t)).status).toBe('warned');
	});

	it('a suspension on another metric during the hold does not end the hold', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const t = await harness();
		await seedSettings(t, { abuseStatus: 'suspended', abuseStatusChangedBy: 'system' });
		await liftByAdmin(t);
		await t.run(async (ctx) => {
			const row = await ctx.db.query('instanceSettings').first();
			await ctx.db.patch(row!._id, {
				reputationCheckHold: { until: NOW + 7 * DAY_MS, triggers: [{ code: 'bounce_rate' }] },
			});
		});
		await t.mutation(internal.workspaces.abuseStatus.transition, {
			input: {
				to: 'suspended',
				at: NOW + 1,
				reason: 'Auto-suspended: complaints',
				changedBy: 'system',
				trigger: { code: 'complaint_rate' },
			},
		});

		const row = await t.run(async (ctx) => await ctx.db.query('instanceSettings').first());
		expect(row?.reputationCheckHold?.triggers).toEqual([{ code: 'bounce_rate' }]);
	});

	it('still suspends during the hold on evidence that was not over the line at the lift', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const t = await harness();
		await seedSettings(t, { abuseStatus: 'suspended', abuseStatusChangedBy: 'system' });
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(NOW),
			totalSent: 1000,
			totalBounced: 120,
		});
		await liftByAdmin(t);

		// Complaints arrive after the lift: 0.5%, over the 0.3% that suspends.
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(NOW),
			shardKey: 1,
			totalComplaints: 5,
		});
		vi.setSystemTime(NOW + HOUR_MS);
		await evaluate(t);

		expect(await abuseState(t)).toMatchObject({
			status: 'suspended',
			trigger: { code: 'complaint_rate' },
		});
	});
});

describe('evaluateAutoEnforce — a warning the check set clears by itself', () => {
	const NOW = Date.UTC(2026, 10, 20, 12);
	afterEach(() => vi.useRealTimers());

	const systemWarning = {
		abuseStatus: 'warned',
		abuseStatusReason: 'Auto-warned: complaint rate or bounce rate exceeding safe thresholds',
		abuseStatusChangedAt: NOW - DAY_MS,
		abuseStatusChangedBy: 'system',
		abuseStatusTrigger: { code: 'bounce_rate' },
	};

	async function auditRows(t: Tester) {
		return await t.run(async (ctx) =>
			(await ctx.db.query('auditLogs').collect()).filter((l) => l.action === 'abuse_status_changed')
		);
	}

	it('clears once its trigger is under the line below the warning line, not before', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const t = await harness();
		await seedSettings(t, systemWarning);
		// 3%: under the 5% that warns, still over the 2% that clears it.
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(NOW),
			totalSent: 1000,
			totalBounced: 30,
		});

		await evaluate(t);
		expect(await abuseState(t)).toMatchObject({
			status: 'warned',
			trigger: { code: 'bounce_rate' },
		});

		// Another 1000 clean sends bring the window to 1.5%.
		await seedBucket(t, { scope: 'org', periodStart: dayStart(NOW), shardKey: 1, totalSent: 1000 });
		await evaluate(t);

		const state = await abuseState(t);
		expect(state.status).toBe('clean');
		expect(state.trigger).toBeUndefined();
		const cleared = (await auditRows(t)).filter((l) => l.details?.['newStatus'] === 'clean');
		expect(cleared).toHaveLength(1);
		expect(cleared[0]?.userId).toBe('system');
		expect(cleared[0]?.details?.['trigger']).toBe('bounce_rate');
		expect(cleared[0]?.details?.['reason']).toBe(
			'Cleared automatically: the bounce rate is back under 2.00%'
		);
	});

	it('clears even when the instance waits for a platform admin to lift suspensions', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const t = await harness();
		await seedSettings(t, { ...systemWarning, isSendingResumeManual: true });
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(NOW),
			totalSent: 1000,
			totalBounced: 10,
		});

		await evaluate(t);

		expect((await abuseState(t)).status).toBe('clean');
	});

	it('moves to the metric still over the warning line instead of clearing', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const t = await harness();
		await seedSettings(t, systemWarning);
		// Bounces 1% (cleared), complaints 0.25% (over the 0.2% warning line).
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(NOW),
			totalSent: 2000,
			totalBounced: 20,
			totalComplaints: 5,
		});

		await evaluate(t);

		expect(await abuseState(t)).toMatchObject({
			status: 'warned',
			trigger: { code: 'complaint_rate' },
		});
	});

	it.each([
		['keeps its uncleared trigger when another metric only warns', 2, 'warned', 'bounce_rate'],
		['suspends on the metric that crossed the suspension line', 3, 'suspended', 'complaint_rate'],
	])('%s', async (_label, complaints, status, trigger) => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const t = await harness();
		await seedSettings(t, systemWarning);
		// Bounces at 3%: under the warning line, still over the 2% that clears it.
		await seedBucket(t, {
			scope: 'org',
			periodStart: dayStart(NOW),
			totalSent: 1000,
			totalBounced: 30,
			totalComplaints: complaints,
		});

		await evaluate(t);

		expect(await abuseState(t)).toMatchObject({ status, trigger: { code: trigger } });
	});

	it('a Gmail warning clears once no reading in the window is at Google’s guidance', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const t = await harness();
		await seedSettings(t, {
			...systemWarning,
			abuseStatusTrigger: { code: 'gmail_spam_rate', domain: 'news.example.com' },
		});
		await t.run(async (ctx) => {
			const domainId = await ctx.db.insert(
				'domains',
				createTestDomain({ domain: 'news.example.com', status: 'verified' })
			);
			await ctx.db.insert('googlePostmasterStats', {
				domainId,
				domain: 'news.example.com',
				periodStart: dayStart(NOW - 10 * DAY_MS),
				userReportedSpamRatio: 0.0015,
				fetchedAt: NOW - 9 * DAY_MS,
				ingestedAt: NOW - 9 * DAY_MS,
			});
		});

		await evaluate(t);
		expect((await abuseState(t)).status).toBe('warned');

		vi.setSystemTime(NOW + 21 * DAY_MS);
		await evaluate(t);
		expect((await abuseState(t)).status).toBe('clean');
	});

	it.each([
		[
			'a warning a platform admin set',
			{ abuseStatus: 'warned', abuseStatusChangedBy: 'admin-1', abuseStatusReason: 'watch it' },
		],
		[
			'an MTA complaint-rate alert',
			{
				abuseStatus: 'warned',
				abuseStatusChangedBy: 'mta_campaign_complaint_rate',
				abuseStatusReason: 'MTA campaign complaint rate: high (0.40%) [campaign c1]',
			},
		],
		[
			'a legacy auto-warning with no stored trigger',
			{
				abuseStatus: 'warned',
				abuseStatusChangedBy: 'system',
				abuseStatusReason: systemWarning.abuseStatusReason,
			},
		],
	])('never clears %s', async (_label, row) => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const t = await harness();
		await seedSettings(t, row);
		await seedBucket(t, { scope: 'org', periodStart: dayStart(NOW), totalSent: 1000 });

		await evaluate(t);

		expect((await abuseState(t)).status).toBe('warned');
	});

	it('a platform admin who sets the warning the check set takes it over', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const t = await harness();
		await seedSettings(t, systemWarning);
		await t.mutation(internal.workspaces.abuseStatus.adminOverride, {
			input: { to: 'warned', at: NOW, reason: 'keep an eye on it', changedBy: 'admin-1' },
		});
		await seedBucket(t, { scope: 'org', periodStart: dayStart(NOW), totalSent: 1000 });

		await evaluate(t);

		const state = await abuseState(t);
		expect(state.status).toBe('warned');
		expect(state.trigger).toBeUndefined();
	});

	it('sends no notice when a warning clears: warnings never notified', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const t = await harness();
		await seedSettings(t, systemWarning);
		await seedBucket(t, { scope: 'org', periodStart: dayStart(NOW), totalSent: 1000 });

		await evaluate(t);

		expect((await abuseState(t)).status).toBe('clean');
		const notices = await t.run(async (ctx) =>
			(await ctx.db.system.query('_scheduled_functions').collect()).filter((j) =>
				j.name.includes('fanOut')
			)
		);
		expect(notices).toHaveLength(0);
	});
});
