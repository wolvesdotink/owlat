/**
 * The ledger's PLANE tag and the three decision-plane counters that read it.
 *
 * What is pinned here:
 *   - a tagged row round-trips through the schema unchanged, and an untagged one
 *     is byte-for-byte what every caller wrote before the decision plane existed
 *     (the tag is optional and absent means `language` — nothing migrates);
 *   - a decision row is priced off the plane's own rows, so output tokens come
 *     back nonzero and cost nothing;
 *   - a refused attempt still lands, at zero cost, because a 429 rate that only
 *     counts successful calls hides the outage it exists to report;
 *   - the counters' denominators: fallback and throttling are properties of an
 *     ATTEMPT, calibration of an ANSWER.
 */
import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import {
	recordDecisionSpend,
	summarizeDecisionPlane,
	type DecisionCountableEvent,
} from '../llmUsage';

/** The plane's pinned model id, spelled out rather than imported: this file is
 * about the ledger, and the adapter that owns the constant is a `'use node'`
 * module the ledger never loads. `lib/decision/__tests__/pricing.test.ts` is
 * where the two are checked against each other. */
const PINNED_DECISION_MODEL = 'jev-1.13.0';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue({
			userId: 'test-user',
			activeOrganizationId: 'tenant-a',
			role: 'owner',
		}),
	};
});

// Vite's `import.meta.glob` excludes the directory chain it climbed to reach the
// glob base, so `'../../**'` from this `analytics/__tests__` file omits the
// sibling `analytics/*` modules — `llmUsage.ts` among them. Merge a second glob
// rooted at `analytics/` and re-prefix its keys to the same `../../`-relative
// form, the way `reputationSnapshots.test.ts` does.
const rootGlob = import.meta.glob('../../**/*.*s');
const analyticsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../analytics/'),
		mod,
	])
);
const modules = Object.fromEntries(
	Object.entries({ ...rootGlob, ...analyticsGlob }).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('visualizationAgent') &&
			!path.includes('semanticFileProcessing')
	)
);

describe('the plane tag on llmUsageEvents', () => {
	it('round-trips the decision tag and its flags, and prices output at zero', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(internal.analytics.llmUsage.record, {
			feature: 'agent_security_scan',
			modelUsed: PINNED_DECISION_MODEL,
			tokenUsage: { promptTokens: 1_000_000, completionTokens: 4_000, totalTokens: 1_004_000 },
			plane: 'decision',
			isFallback: false,
			isCalibrated: true,
			isThrottled: false,
		});

		await t.run(async (ctx) => {
			const [row] = await ctx.db.query('llmUsageEvents').collect();
			expect(row?.plane).toBe('decision');
			expect(row?.isFallback).toBe(false);
			expect(row?.isCalibrated).toBe(true);
			expect(row?.isThrottled).toBe(false);
			expect(row?.completionTokens).toBe(4_000);
			// Input only: $0.042 per million, output free.
			expect(row?.costUsd).toBeCloseTo(0.042, 9);
		});
	});

	it('leaves an untagged row exactly as it was before the plane existed', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(internal.analytics.llmUsage.record, {
			feature: 'assistant_ask',
			modelUsed: 'gpt-4o',
			tokenUsage: { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 },
		});

		await t.run(async (ctx) => {
			const [row] = await ctx.db.query('llmUsageEvents').collect();
			expect(row?.plane).toBeUndefined();
			expect(row?.isFallback).toBeUndefined();
			expect(row?.isCalibrated).toBeUndefined();
			expect(row?.isThrottled).toBeUndefined();
			expect(row?.costUsd).toBeGreaterThan(0);
		});
	});

	it('records a refused attempt at zero cost, and still no-ops on an untagged empty call', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(internal.analytics.llmUsage.record, {
			feature: 'agent_classify',
			modelUsed: PINNED_DECISION_MODEL,
			tokenUsage: undefined,
			plane: 'decision',
			isThrottled: true,
		});
		await t.mutation(internal.analytics.llmUsage.record, {
			feature: 'assistant_ask',
			modelUsed: 'gpt-4o',
			tokenUsage: undefined,
		});

		await t.run(async (ctx) => {
			const rows = await ctx.db.query('llmUsageEvents').collect();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.isThrottled).toBe(true);
			expect(rows[0]?.costUsd).toBe(0);
			expect(rows[0]?.totalTokens).toBe(0);
		});
	});

	it('reports the three rates over the same ledger the ceiling reads', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const decisionRow = (over: Partial<DecisionCountableEvent>) => ({
			feature: 'agent_triage',
			modelUsed: PINNED_DECISION_MODEL,
			promptTokens: 10,
			completionTokens: 5,
			totalTokens: 15,
			costUsd: 0.001,
			createdAt: now,
			plane: 'decision' as const,
			...over,
		});
		await t.run(async (ctx) => {
			await ctx.db.insert('llmUsageEvents', decisionRow({ isFallback: false, isCalibrated: true }));
			await ctx.db.insert('llmUsageEvents', decisionRow({ isFallback: false, isCalibrated: true }));
			await ctx.db.insert('llmUsageEvents', decisionRow({ isFallback: true, isCalibrated: false }));
			await ctx.db.insert('llmUsageEvents', decisionRow({ isThrottled: true, costUsd: 0 }));
			// Language-plane spend must not enter any decision denominator.
			await ctx.db.insert('llmUsageEvents', {
				feature: 'assistant_ask',
				modelUsed: 'gpt-4o',
				promptTokens: 10,
				completionTokens: 5,
				totalTokens: 15,
				costUsd: 5,
				createdAt: now,
			});
		});

		const counters = await t.query(api.analytics.llmUsage.getDecisionPlaneCounters, {});

		expect(counters.attempts).toBe(4);
		expect(counters.fallbackRate).toBeCloseTo(0.25, 9);
		expect(counters.throttledRate).toBeCloseTo(0.25, 9);
		// One of the THREE answers that reported calibration was uncalibrated; the
		// throttled attempt never got an answer and is in neither side of it.
		expect(counters.calibrationReported).toBe(3);
		expect(counters.uncalibratedRate).toBeCloseTo(1 / 3, 9);
		expect(counters.costUsd).toBeCloseTo(0.003, 9);
	});
});

describe('summarizeDecisionPlane', () => {
	it('is all zeroes, never NaN, when the plane has not been used', () => {
		const counters = summarizeDecisionPlane([{ costUsd: 1 }, { plane: 'language', costUsd: 2 }]);
		expect(counters).toMatchObject({
			attempts: 0,
			fallbackRate: 0,
			uncalibratedRate: 0,
			throttledRate: 0,
			costUsd: 0,
		});
	});
});

describe('recordDecisionSpend', () => {
	it('tags the plane for the caller and passes the flags through verbatim', async () => {
		const runMutation = vi.fn(async () => undefined);
		const ctx = { runMutation } as unknown as Parameters<typeof recordDecisionSpend>[0];

		await recordDecisionSpend(
			ctx,
			'agent_security_scan',
			{ promptTokens: 10, completionTokens: 2, totalTokens: 12 },
			PINNED_DECISION_MODEL,
			{ isFallback: true, isCalibrated: false }
		);

		expect(runMutation).toHaveBeenCalledWith(internal.analytics.llmUsage.record, {
			feature: 'agent_security_scan',
			modelUsed: PINNED_DECISION_MODEL,
			tokenUsage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
			plane: 'decision',
			isFallback: true,
			isCalibrated: false,
			isThrottled: undefined,
		});
	});
});
