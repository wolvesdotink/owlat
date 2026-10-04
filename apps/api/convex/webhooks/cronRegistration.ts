import type { cronJobs } from 'convex/server';
import { internal } from '../_generated/api';

type Crons = ReturnType<typeof cronJobs>;

/**
 * Webhook crons. Moved here unchanged from `convex/crons.ts` (same names,
 * cadences and arguments) when the unresolved-feedback replay would have
 * pushed that file past the 500-LOC cap.
 */
export function registerWebhookCrons(crons: Crons): void {
	// Clean up old webhook delivery logs weekly
	// Removes logs older than 30 days to prevent unbounded growth
	crons.interval('cleanup webhook logs', { hours: 168 }, internal.webhooks.cleanup.cleanupOldLogs);

	// Re-issue outbound webhook attempts that were lost (the scheduler job failed or
	// vanished before recording an outcome), so no delivery sits in pending/retrying
	// forever. Bounded batches; see webhooks/deliveryReconciler.ts.
	crons.interval(
		'reconcile overdue webhook deliveries',
		{ minutes: 5 },
		internal.webhooks.deliveryReconciler.reconcileOverdueDeliveries,
		{}
	);
	crons.interval(
		'cleanup MTA campaign alert receipts',
		{ hours: 24 },
		internal.webhooks.cleanup.cleanupCampaignAlertReceipts,
		{}
	);

	// Sweep expired bundled-plugin replay claims. The claim mutation ages
	// its own table out on the hot path, but only while deliveries keep arriving:
	// disabling a plugin or a provider going quiet strands whatever the last sweep
	// left. Rows expire within the signature contract's tolerance (≤ 15 minutes), so
	// a daily pass leaves nothing behind for long.
	crons.interval(
		'cleanup plugin webhook replay claims',
		{ hours: 24 },
		internal.webhooks.cleanup.cleanupPluginWebhookDeliveries,
		{}
	);

	// Sweep expired provider-event replay claims (#1228). Rows expire a day after
	// their event; the claim hot path sweeps too, but only while events arrive.
	crons.interval(
		'cleanup provider event replay claims',
		{ hours: 1 },
		internal.webhooks.inboundEventClaims.cleanupExpired,
		{}
	);

	// Clean up old raw webhook payloads weekly. webhookPayloads is written on every
	// webhook ingest; without this cron its retention never runs and the table
	// grows unbounded (only purged on full org deletion).
	crons.interval(
		'cleanup webhook payloads',
		{ hours: 168 },
		internal.webhooks.payloads.cleanupOldPayloads,
		{}
	);

	// Retry bounces and complaints that matched no Send (#1194) while their id may
	// still turn up; one index range read when nothing is due.
	crons.interval(
		'replay unresolved feedback',
		{ minutes: 10 },
		internal.webhooks.unresolvedFeedback.replayDue,
		{}
	);
}
