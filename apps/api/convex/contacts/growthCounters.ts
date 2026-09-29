/**
 * Subscriber growth as a per-day counter (plan 3.1), on the `lib/counters.ts`
 * engine: one bucket per UTC day, holding the number of LIVE contacts
 * (`deletedAt === undefined`) created that day. The 30-day growth chart reads
 * 30 bucket rows instead of every contact created in the window.
 *
 * Every contact insert, soft delete and hard delete calls
 * {@link recordContactGrowth} in the same mutation. The backfill walks the
 * table in creation order, so a contact's position is its `_creationTime`.
 */

import type { DatabaseReader, MutationCtx } from '../_generated/server';
import {
	applyCounterChange,
	creationPosition,
	loadCounterScope,
	type CounterKind,
} from '../lib/counters';
import { utcDayKey } from '../lib/clock';

type CountedContact = { _creationTime?: number; createdAt: number; deletedAt?: number };

/** The growth scope has no owner, so its key is its kind (`counterScopeKey`). */
const CONTACT_GROWTH_SCOPE = 'contactCreatedDay' satisfies CounterKind;

export function contactGrowthBuckets(contact: CountedContact): readonly string[] {
	return contact.deletedAt === undefined ? [utcDayKey(contact.createdAt)] : [];
}

/** Move one contact's day bucket (`before` null for an insert, `after` null for a delete). */
export async function recordContactGrowth(
	ctx: MutationCtx,
	before: CountedContact | null,
	after: CountedContact | null
): Promise<void> {
	const row = before ?? after;
	if (!row) return;
	await applyCounterChange(
		ctx,
		CONTACT_GROWTH_SCOPE,
		creationPosition(row),
		before ? contactGrowthBuckets(before) : [],
		after ? contactGrowthBuckets(after) : []
	);
}

/**
 * Live contacts created per UTC day for the days `firstDay`..`lastDay`
 * (`YYYY-MM-DD`, inclusive), or null until the counter is backfilled. Days with
 * no signups have no row and are absent from the map.
 */
export async function readContactGrowth(
	db: DatabaseReader,
	firstDay: string,
	lastDay: string
): Promise<Map<string, number> | null> {
	const state = await loadCounterScope(db, CONTACT_GROWTH_SCOPE);
	if (!state?.isReady) return null;
	const rows = await db
		.query('counterBuckets')
		.withIndex('by_scope_and_bucket', (q) =>
			q.eq('scope', CONTACT_GROWTH_SCOPE).gte('bucket', firstDay).lte('bucket', lastDay)
		)
		.take(400); // bounded: one row per day of a ~30-day window
	return new Map(rows.map((row) => [row.bucket, row.count]));
}
