/**
 * Visualization Agent
 *
 * Generates interactive HTML/CSS/JS visualizations from
 * natural language prompts. Uses LLM to query data and
 * produce self-contained visualization code that renders
 * in a sandboxed iframe.
 *
 * The generation action itself lives in `./visualizationAgentActions.ts`
 * (`'use node'`, for the shared LLM dispatch); this module keeps the
 * isolate-side queries, mutations and live-data fetchers.
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import { adminQuery, authedMutation } from './lib/authedFunctions';
import { requireAdminContext } from './lib/sessionOrganization';
import { internal } from './_generated/api';
import { getOrThrow } from './_utils/errors';
import { validateStringLength, STRING_LIMITS } from './lib/inputGuards';
import { getCachedContactCount } from './lib/contactCountHelpers';
import { readDailyStats } from './lib/sendDailyStats';

// ============================================================
// Live-data allowlist
// ============================================================
//
// SAFETY MODEL: the visualization agent never executes free-form queries. The
// only way real account numbers reach the LLM is through one of the fixed,
// named datasets below, each of which maps to a hand-written, read-only
// internal fetcher in this file. There is no path to inject a raw query
// string — `dataQuery` stores a *dataset key* from this union, nothing else.
//
// The set is intentionally tiny and read-only. Adding a dataset means adding
// both a literal here and a fetcher case in `fetchDataset`
// (`./visualizationAgentActions.ts`).

const DATASET_KEYS = [
	'email_delivery_30d',
	'agent_health',
	'contact_growth',
	'campaign_performance',
] as const;

export type DatasetKey = (typeof DATASET_KEYS)[number];

export const datasetKeyValidator = v.union(
	v.literal('email_delivery_30d'),
	v.literal('agent_health'),
	v.literal('contact_growth'),
	v.literal('campaign_performance')
);

export function isDatasetKey(value: string): value is DatasetKey {
	return (DATASET_KEYS as readonly string[]).includes(value);
}

// Live account data is OPT-IN ONLY: a caller must pass an explicit, allowlisted
// `dataset` key (e.g. from a dataset picker). Free-form prompts are never routed
// to real numbers — keyword inference used to quietly chart a user's real
// delivery/campaign/contact data while the UI promised "illustrative sample data
// — not your account's real analytics". The default is now illustrative, as the
// copy says; opt in to live data with an explicit `dataset`.

// ============================================================
// Queries
// ============================================================

/**
 * List visualizations (most recent first)
 */
export const list = adminQuery({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		return await ctx.db
			.query('visualizations')
			.withIndex('by_created_at')
			.order('desc')
			.take(args.limit ?? 20);
	},
});

/**
 * Get pinned visualizations for the dashboard
 */
export const listPinned = adminQuery({
	args: {},
	handler: async (ctx) => {
		return await ctx.db
			.query('visualizations')
			.withIndex('by_pinned', (q) => q.eq('pinned', true))
			.collect(); // bounded: pinned visualizations (few)
	},
});

// ============================================================
// Mutations
// ============================================================

/**
 * Create a visualization request and kick off generation
 */
export const createFromPrompt = authedMutation({
	args: {
		prompt: v.string(),
		pinned: v.optional(v.boolean()),
		// Optional explicit live-data selection. When omitted, the chart uses
		// illustrative sample data — prompts are never routed to real account
		// data. Only the fixed allowlist is accepted; no free-form query channel.
		dataset: v.optional(datasetKeyValidator),
	},
	handler: async (ctx, args) => {
		const session = await requireAdminContext(ctx);
		// Bound the prompt — it feeds an LLM call, so an unbounded string is a
		// (admin-only) cost/abuse vector.
		validateStringLength(args.prompt, STRING_LIMITS.DESCRIPTION, 'Prompt');
		const now = Date.now();

		// Create a placeholder visualization
		const id = await ctx.db.insert('visualizations', {
			title: args.prompt.slice(0, 100),
			description: args.prompt,
			html: '<div style="padding:20px;text-align:center;color:#666;">Generating visualization...</div>',
			pinned: args.pinned ?? false,
			createdBy: session.userId, // Real creator: the admin session that issued the request.
			createdAt: now,
			updatedAt: now,
		});

		// Schedule the generation action
		await ctx.scheduler.runAfter(0, internal.visualizationAgentActions.generate, {
			visualizationId: id,
			prompt: args.prompt,
			dataset: args.dataset,
		});

		return id;
	},
});

/**
 * Re-run generation for an existing visualization, re-fetching its persisted
 * allowlisted dataset so the chart reflects current account numbers.
 *
 * Refresh is only meaningful for a live-data visualization: `dataQuery` holds
 * the allowlisted dataset key the chart was built from (or `undefined` for an
 * illustrative one). We re-schedule `generate` with the same key — the fetcher
 * pulls fresh numbers, so nothing here accepts a raw query string. An
 * illustrative chart has no dataset to refresh, so it is rejected.
 */
export const regenerate = authedMutation({
	args: { id: v.id('visualizations') },
	handler: async (ctx, args) => {
		await requireAdminContext(ctx);
		const viz = await getOrThrow(ctx, args.id, 'Visualization');

		// Only live-data visualizations carry a refreshable dataset key.
		const dataset =
			viz.dataQuery !== undefined && isDatasetKey(viz.dataQuery) ? viz.dataQuery : undefined;
		if (dataset === undefined) {
			throw new Error('This visualization uses illustrative sample data and cannot be refreshed.');
		}

		await ctx.db.patch(args.id, {
			html: '<div style="padding:20px;text-align:center;color:#666;">Refreshing visualization...</div>',
			updatedAt: Date.now(),
		});

		await ctx.scheduler.runAfter(0, internal.visualizationAgentActions.generate, {
			visualizationId: args.id,
			prompt: viz.description ?? viz.title,
			dataset,
		});
	},
});

/**
 * Pin/unpin a visualization
 */
export const togglePin = authedMutation({
	args: { id: v.id('visualizations') },
	handler: async (ctx, args) => {
		await requireAdminContext(ctx);
		const viz = await getOrThrow(ctx, args.id, 'Visualization');

		await ctx.db.patch(args.id, {
			pinned: !viz.pinned,
			updatedAt: Date.now(),
		});
	},
});

/**
 * Delete a visualization
 */
export const remove = authedMutation({
	args: { id: v.id('visualizations') },
	handler: async (ctx, args) => {
		await requireAdminContext(ctx);
		await ctx.db.delete(args.id);
	},
});

/**
 * Internal mutation to update a visualization after generation
 */
export const updateGenerated = internalMutation({
	args: {
		id: v.id('visualizations'),
		title: v.string(),
		html: v.string(),
		// Allowlisted dataset key the viz was built from (for refresh), or
		// undefined when illustrative sample data was used.
		dataQuery: v.optional(datasetKeyValidator),
	},
	handler: async (ctx, args) => {
		await ctx.db.patch(args.id, {
			title: args.title,
			html: args.html,
			dataQuery: args.dataQuery,
			updatedAt: Date.now(),
		});
	},
});

// ============================================================
// Live-data fetchers (read-only, allowlisted)
// ============================================================
//
// Each fetcher reads a small, bounded slice of an existing table through a
// dedicated internal query. They never accept caller-supplied query text —
// the dataset key (one of `DATASET_KEYS`) is the entire input surface.

/**
 * Last 30 daily send roll-up rows (one row per UTC day). Bounded by the
 * `daily_stats_bump` lifecycle effect — at most 30 small docs.
 */
export const dataEmailDelivery30d = internalQuery({
	args: {},
	handler: async (ctx) => {
		// Per-day stats summed across write shards, oldest-first for a
		// left-to-right time series. Bounded to 30 days × SHARD_COUNT small docs.
		return readDailyStats(ctx.db, 30, Date.now());
	},
});

/**
 * Current agent pipeline health: latest value per metric type (last 5 min)
 * plus circuit-breaker states. Bounded to a small fixed set of metric types
 * and breakers.
 */
export const dataAgentHealth = internalQuery({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const fiveMinAgo = now - 5 * 60 * 1000;

		const recent = await ctx.db
			.query('agentMetrics')
			.withIndex('by_window_start', (q) => q.gte('windowStart', fiveMinAgo))
			.take(500); // bounded: 7 metric types × 5-min windows is tiny

		const latest: Record<string, { value: number; createdAt: number }> = {};
		for (const m of recent) {
			const prev = latest[m.metricType];
			if (!prev || m.createdAt > prev.createdAt) {
				latest[m.metricType] = { value: m.value, createdAt: m.createdAt };
			}
		}

		const breakers = await ctx.db.query('agentCircuitBreakers').take(20); // bounded: fixed small set of breaker types

		return {
			metrics: {
				queueDepth: latest['queue_depth']?.value ?? 0,
				processingLatencyMs: latest['processing_latency']?.value ?? 0,
				errorRate: latest['error_rate']?.value ?? 0,
				autoApproveRatio: latest['auto_approve_ratio']?.value ?? 0,
				rejectionRate: latest['rejection_rate']?.value ?? 0,
				llmCost: latest['llm_cost']?.value ?? 0,
			},
			circuitBreakers: breakers.map((b) => ({
				type: b.breakerType,
				state: b.state,
				currentValue: b.currentValue,
				threshold: b.threshold,
			})),
		};
	},
});

/**
 * New contacts per day for the last 30 days plus the cached total. Reads only
 * the trailing window via the `by_created_at` index (capped), so it stays
 * bounded regardless of total contact count.
 */
export const dataContactGrowth = internalQuery({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

		const recent = await ctx.db
			.query('contacts')
			.withIndex('by_created_at', (q) => q.gte('createdAt', thirtyDaysAgo))
			.take(5000); // bounded: trailing 30-day window only

		const perDay: Record<string, number> = {};
		for (const c of recent) {
			// Exclude soft-deleted contacts from the growth curve.
			if (c.deletedAt !== undefined) continue;
			const day = new Date(c.createdAt).toISOString().slice(0, 10); // YYYY-MM-DD
			perDay[day] = (perDay[day] ?? 0) + 1;
		}

		const series = Object.entries(perDay)
			.map(([date, count]) => ({ date, newContacts: count }))
			.sort((a, b) => (a.date < b.date ? -1 : 1));

		// Distinguish "cache not initialized" (null) from a genuine zero. A null
		// total must NOT be fed to the live-data prompt as "0 contacts" — that
		// would assert a confidently-wrong figure. Throwing routes the whole
		// dataset through generate()'s illustrative fallback instead.
		const cachedTotal = await getCachedContactCount(ctx);
		if (cachedTotal === null || cachedTotal === undefined) {
			throw new Error('Contact count cache not initialized — falling back to illustrative data');
		}

		return {
			totalContacts: cachedTotal,
			newInLast30Days: series.reduce((sum, p) => sum + p.newContacts, 0),
			series,
		};
	},
});

/**
 * Performance of the most recently sent campaigns (up to 20). Reads via the
 * `by_status_sent_at` index so it stays a bounded, ordered slice.
 */
export const dataCampaignPerformance = internalQuery({
	args: {},
	handler: async (ctx) => {
		const sent = await ctx.db
			.query('campaigns')
			.withIndex('by_status_sent_at', (q) => q.eq('status', 'sent'))
			.order('desc')
			.take(20);

		return sent.map((c) => ({
			name: c.name,
			sentAt: c.sentAt ?? null,
			sent: c.statsSent ?? 0,
			delivered: c.statsDelivered ?? 0,
			opened: c.statsOpened ?? 0,
			clicked: c.statsClicked ?? 0,
			bounced: c.statsBounced ?? 0,
			unsubscribed: c.statsUnsubscribed ?? 0,
		}));
	},
});
