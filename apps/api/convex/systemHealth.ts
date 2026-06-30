import { authedQuery } from './lib/authedFunctions';
import { getUserIdFromSession } from './lib/sessionOrganization';
import { summarize } from './analytics/sendingReputation';

// We only need to know whether the queue is small, >100 (degraded), or >500
// (issue), so we count 'queued' sends up to this cap via the global by_status
// index rather than scanning every send.
const QUEUE_PROBE_CAP = 501;

// Get system health stats — email queue depth and delivery success rates.
//
// Both inputs are bounded. Delivery/bounce numbers come from the maintained
// `sendingReputation` org buckets (a ~480-row rolling-window scan summed by the
// module's canonical `summarize` seam), so this no longer collects every
// campaign, then every send per campaign, then every transactional send (an
// O(all sends) N+1 that would trip the read limit at scale). Queue depth is a
// capped `.take()` over the by_status index.
export const getHealthStats = authedQuery({
	args: {},
	handler: async (ctx) => {
		await getUserIdFromSession(ctx);
		const now = Date.now();

		// Rolling-window delivery health for the whole deployment. Every send
		// (campaign, transactional, automation, agent reply) records a reputation
		// event, so this is both more complete than the old campaign+transactional
		// scan and O(bounded).
		const rep = await summarize(ctx.db, { kind: 'org' });

		// Email queue depth: count 'queued' sends via the global by_status index,
		// capped so a large in-flight campaign can't make this unbounded.
		const queued = await ctx.db
			.query('emailSends')
			.withIndex('by_status', (q) => q.eq('status', 'queued'))
			.take(QUEUE_PROBE_CAP);
		const emailQueueDepth = queued.length;
		const queueTruncated = emailQueueDepth >= QUEUE_PROBE_CAP;

		const recentDeliveryRate =
			rep.totalSent > 0 ? Math.round((rep.totalDelivered / rep.totalSent) * 100) : null;

		// Determine overall system status.
		// "operational" - all systems working normally
		// "degraded"    - some issues (elevated bounce rate, queue building up)
		// "issue"       - significant problems
		let status: 'operational' | 'degraded' | 'issue' = 'operational';
		const issues: string[] = [];

		// High bounce rate over the reputation window (>5% concerning, >10% an
		// issue). Guarded by a minimum sample so a couple of early bounces don't
		// trip the alarm.
		if (rep.totalSent > 10) {
			const bounceRatePct = rep.bounceRate * 100;
			if (bounceRatePct > 10) {
				status = 'issue';
				issues.push(`High bounce rate: ${bounceRatePct.toFixed(1)}%`);
			} else if (bounceRatePct > 5) {
				status = 'degraded';
				issues.push(`Elevated bounce rate: ${bounceRatePct.toFixed(1)}%`);
			}
		}

		// A large queue may indicate a sending issue. Check the higher threshold
		// first so it isn't masked by the lower one.
		if (emailQueueDepth > 500) {
			status = 'issue';
			issues.push(
				`${queueTruncated ? '500+' : emailQueueDepth} emails in queue (possible delivery issue)`,
			);
		} else if (emailQueueDepth > 100) {
			if (status === 'operational') {
				status = 'degraded';
			}
			issues.push(`${emailQueueDepth} emails queued`);
		}

		return {
			status,
			issues,
			emailQueueDepth,
			recentDeliveryRate,
			stats: {
				recentSent: rep.totalSent,
				recentDelivered: rep.totalDelivered,
				recentBounced: rep.totalBounced,
			},
			updatedAt: now,
		};
	},
});
