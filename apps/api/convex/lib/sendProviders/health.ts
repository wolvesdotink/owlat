/**
 * Send provider health (module).
 *
 * Per ADR-0020. Renamed from `lib/emailProviders/healthTracker.ts`; identical
 * content, moved alongside its consumers (the **Send dispatch (helper)** is
 * now the only writer; `resolveRoute` is the only reader of the all-providers
 * snapshot).
 *
 * Health thresholds:
 *   - healthy: success rate >= 90%
 *   - degraded: success rate >= 50% but < 90%
 *   - down: success rate < 50% or >= 5 consecutive failures
 */

import { v } from 'convex/values';
import { internalMutation } from '../../_generated/server';

type HealthStatus = 'healthy' | 'degraded' | 'down';

const HEALTH_THRESHOLDS = {
	/** Below this success rate, provider is considered "down" */
	DOWN_THRESHOLD: 0.5,
	/** Below this success rate (but above down), provider is "degraded" */
	DEGRADED_THRESHOLD: 0.9,
	/** Consecutive failures to trigger "down" status */
	MAX_CONSECUTIVE_FAILURES: 5,
	/** Window size for rolling metrics (number of sends tracked) */
	ROLLING_WINDOW: 100,
} as const;

function calculateStatus(
	successRate: number,
	consecutiveFailures: number,
): HealthStatus {
	if (
		consecutiveFailures >= HEALTH_THRESHOLDS.MAX_CONSECUTIVE_FAILURES ||
		successRate < HEALTH_THRESHOLDS.DOWN_THRESHOLD
	) {
		return 'down';
	}
	if (successRate < HEALTH_THRESHOLDS.DEGRADED_THRESHOLD) {
		return 'degraded';
	}
	return 'healthy';
}

/**
 * Record the result of a send attempt for a provider.
 * Updates rolling success/failure counts, latency, and health status.
 * The **Send dispatch (helper)** is the only writer.
 */
export const recordSendResult = internalMutation({
	args: {
		providerType: v.string(),
		success: v.boolean(),
		latencyMs: v.number(),
	},
	handler: async (ctx, args) => {
		const now = Date.now();

		// Find or create the health record for this provider
		const record = await ctx.db
			.query('providerHealth')
			.withIndex('by_provider_type', (q) => q.eq('providerType', args.providerType))
			.first();

		if (!record) {
			const id = await ctx.db.insert('providerHealth', {
				providerType: args.providerType,
				status: 'healthy',
				recentSuccesses: args.success ? 1 : 0,
				recentFailures: args.success ? 0 : 1,
				successRate: args.success ? 1 : 0,
				avgLatencyMs: args.latencyMs,
				lastCheckedAt: now,
				lastErrorAt: args.success ? undefined : now,
				consecutiveFailures: args.success ? 0 : 1,
			});
			return await ctx.db.get(id);
		}

		// Update counters with exponential decay (approximate rolling window)
		// Decay factor: keep ~99% of history each update
		const decayFactor = 0.99;
		const newSuccesses = record.recentSuccesses * decayFactor + (args.success ? 1 : 0);
		const newFailures = record.recentFailures * decayFactor + (args.success ? 0 : 1);
		const total = newSuccesses + newFailures;
		const successRate = total > 0 ? newSuccesses / total : 1;

		// Update consecutive failures
		const consecutiveFailures = args.success ? 0 : record.consecutiveFailures + 1;

		// Update average latency (exponential moving average)
		const avgLatencyMs = record.avgLatencyMs * 0.9 + args.latencyMs * 0.1;

		const status = calculateStatus(successRate, consecutiveFailures);

		await ctx.db.patch(record._id, {
			recentSuccesses: newSuccesses,
			recentFailures: newFailures,
			successRate,
			avgLatencyMs,
			lastCheckedAt: now,
			lastErrorAt: args.success ? record.lastErrorAt : now,
			consecutiveFailures,
			status,
		});
	},
});

