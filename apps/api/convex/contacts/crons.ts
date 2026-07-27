/**
 * Contact-hygiene crons.
 *
 * These four schedules all do the same KIND of work — keeping the contact book
 * honest between user actions — and they were the tail of a `crons.ts` that had
 * reached the ~500 LOC split threshold CONVENTIONS.md sets. Registration still
 * happens at module load from `crons.ts`; only the grouping moved, so the job
 * names, cadences and arguments are byte-for-byte what they were.
 */

import { cronJobs } from 'convex/server';
import { internal } from '../_generated/api';

type Crons = ReturnType<typeof cronJobs>;

export function registerContactHygieneCrons(crons: Crons): void {
	// Permanently delete soft-deleted contacts whose 30-day retention has expired.
	// Cascades to contact-owned children and nulls out FKs in append-only tables.
	crons.interval(
		'cleanup soft-deleted contacts',
		{ hours: 24 },
		internal.contacts.contacts.cleanupSoftDeletedContacts,
		{}
	);

	// Auto-merge unambiguous duplicate contacts (same email/phone across two
	// contacts) every 6 hours. Single-org hygiene; bounded per run.
	crons.interval(
		'auto-merge duplicate contacts',
		{ hours: 6 },
		internal.contacts.identities.autoMergeDuplicates,
		{ limit: 20 }
	);

	// Re-project stale contact engagement scores so a score decays on the clock,
	// not only when the contact acts. Bounded per tick IN DOCUMENTS (each contact
	// costs up to 500 activity reads), which is why this is hourly rather than
	// nightly: capacity comes from ticks, and `BACKFILL_CONTACTS_PER_HOUR` states
	// the resulting ceiling.
	crons.interval(
		'backfill contact engagement scores',
		{ hours: 1 },
		internal.analytics.engagementScoreSync.backfillEngagementScores,
		{}
	);

	// Sunset policy (deliverability plan P4-4): move contacts that have ignored
	// every message for the configured window onto the re-engagement track, then
	// auto-suppress them. Bounded per tick (`SUNSET_CONTACTS_PER_TICK`) and
	// resumable from its index cursor. HOURLY, not daily: `SUNSET_STALE_MS`
	// already pins each individual contact to at most one evaluation a day, so
	// the cadence buys THROUGHPUT — a daily tick would cap the whole deployment
	// at 1000 contacts a day, leaving any larger list permanently behind its own
	// stale range.
	crons.interval(
		'sweep contact sunset policy',
		{ hours: 1 },
		internal.contacts.sunset.sweepSunsetPolicy,
		{}
	);
}
