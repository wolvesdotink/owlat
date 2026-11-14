/**
 * The crons of the migrations that start themselves (`startsItself` in
 * `manifest.ts`). Registered at module load from `crons.ts`; each `ensure`
 * costs one indexed read once its migration has completed.
 */

import type { cronJobs } from 'convex/server';
import { internal } from '../_generated/api';

type Crons = ReturnType<typeof cronJobs>;

export function registerMigrationCrons(crons: Crons): void {
	// IMAP folder membership backfill: start migration 0054 on a deployment
	// that never ran it, and resume one whose chain died, so every deployment
	// stops listing whole folders for the IMAP server.
	crons.interval(
		'ensure folder membership backfill',
		{ minutes: 10 },
		internal.migrations['0054_backfill_folder_membership'].ensure,
		{}
	);

	// System sender domain: register it on an install seeded before the seed
	// did, as soon as a system sender and the built-in MTA are configured.
	crons.interval(
		'ensure system sender domain',
		{ hours: 1 },
		internal.migrations['0075_register_system_sender_domain'].ensure,
		{}
	);
}
