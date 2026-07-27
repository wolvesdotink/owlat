/**
 * Delivery-domain RETENTION sweeps, registered as one group.
 *
 * Same shape as `plugins/cronRegistration.ts`: `crons.ts` owns the schedule
 * object, a domain module owns its own registrations. Extracted because
 * `crons.ts` had reached the ~500 LOC split threshold CONVENTIONS.md sets, and
 * because these five entries are one thing — every delivery table whose rows
 * expire is swept here, in bounded, indexed, self-resuming batches, so a new
 * retained delivery table has an obvious home rather than another line in a
 * 500-line file.
 *
 * Scheduling only. Every handler lives in its own domain module; nothing here
 * changes what those sweeps do or how often they run.
 */

import type { cronJobs } from 'convex/server';
import { internal } from '../_generated/api';

type Crons = ReturnType<typeof cronJobs>;

export function registerDeliveryRetentionCrons(crons: Crons): void {
	crons.interval(
		'cleanup deliverability route state',
		{ minutes: 5 },
		internal.delivery.deliverabilityRouting.cleanupExpired,
		{}
	);

	crons.interval(
		'cleanup delivery compliance telemetry',
		{ hours: 1 },
		internal.delivery.complianceTelemetry.cleanupComplianceTelemetry,
		{}
	);

	// Send assignments are one row per recipient per send (the experiment
	// record), so their retention sweep is not optional. 90 days, deleted in
	// bounded indexed batches that resume via self-scheduling while a tick
	// comes back full.
	crons.interval(
		'cleanup send assignments',
		{ hours: 6 },
		internal.delivery.sendAssignments.cleanupExpiredAssignments,
		{}
	);

	crons.interval(
		'cleanup MTA IP readiness alerts',
		{ hours: 24 },
		internal.delivery.ipReadinessAlerts.cleanupExpired,
		{}
	);

	crons.interval(
		'cleanup Google Postmaster telemetry',
		{ hours: 24 },
		internal.delivery.postmaster.cleanup,
		{}
	);
}
