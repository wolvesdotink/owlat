import type { cronJobs } from 'convex/server';
import { internal } from '../_generated/api';

type Crons = ReturnType<typeof cronJobs>;

/**
 * The company index sweep. The index trails the mail by at most this interval;
 * its first runs on an existing install are the backfill (companies/indexer.ts).
 */
export function registerCompanyCrons(crons: Crons): void {
	crons.interval(
		'index conversations by company',
		{ minutes: 2 },
		internal.companies.indexer.sweep,
		{}
	);
}
