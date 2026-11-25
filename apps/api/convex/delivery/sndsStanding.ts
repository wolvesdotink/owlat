/**
 * What Microsoft currently says about each sending address, and the one thing
 * Owlat does about it.
 *
 * SNDS gives every address a daily filter result. A fresh `red` means Outlook
 * filters most of that address's mail, so the MTA sends Microsoft mail from it
 * at Microsoft's floor rate (an (IP, Microsoft) hold, see the MTA's
 * `intelligence/providerHolds.ts`) until SNDS reports it otherwise. Nothing
 * else changes: other addresses, other providers and the workspace's own
 * sending standing are untouched. `yellow` is only shown in the Center.
 *
 * Only the newest day with a known result counts, and only while it is fresh:
 * a newer green day releases the hold, and a reading that stopped arriving
 * changes nothing rather than holding mail on old evidence.
 *
 * Spam-trap hits are their own column and can be non-zero on a green day.
 * The Center shows the newest fresh day with hits next to the address: the
 * list holds addresses that never signed up, which list hygiene fixes and
 * waiting does not. They do not hold traffic.
 */

import type { Doc } from '../_generated/dataModel';
import { internalQuery, type QueryCtx } from '../_generated/server';
import { utcDayStart } from '../lib/clock';
import { DAY_MS } from '../lib/constants';

/** Today and the two days before it: SNDS publishes a day about a day late. */
const SNDS_STANDING_FRESH_DAYS = 3;
/** Far above any sending pool times the fresh window. */
const SNDS_STANDING_ROW_LIMIT = 1_000;

export interface SndsIpStanding {
	ip: string;
	filterResult: 'red' | 'yellow';
	/** UTC midnight of the SNDS day the reading is from. */
	periodStart: number;
}

type StandingRow = Pick<Doc<'sndsIpDailyStats'>, 'ip' | 'periodStart' | 'filterResult'>;

export interface SndsTrapHits {
	ip: string;
	trapHits: number;
	/** UTC midnight of the SNDS day the hits were counted on. */
	periodStart: number;
}

function oldestFreshDay(now: number): number {
	return utcDayStart(now) - (SNDS_STANDING_FRESH_DAYS - 1) * DAY_MS;
}

/** The fresh red or yellow addresses, newest reading per address. */
export function sndsIpStandings(rows: readonly StandingRow[], now: number): SndsIpStanding[] {
	const freshFrom = oldestFreshDay(now);
	const newest = new Map<string, StandingRow>();
	for (const row of rows) {
		if (row.periodStart < freshFrom || row.filterResult === 'unknown') continue;
		const seen = newest.get(row.ip);
		if (!seen || row.periodStart > seen.periodStart) newest.set(row.ip, row);
	}
	return [...newest.values()]
		.flatMap((row) =>
			row.filterResult === 'red' || row.filterResult === 'yellow'
				? [{ ip: row.ip, filterResult: row.filterResult, periodStart: row.periodStart }]
				: []
		)
		.sort((a, b) => a.ip.localeCompare(b.ip));
}

/** Per address, the newest fresh day on which SNDS counted spam-trap hits. */
export function sndsTrapHits(
	rows: readonly Pick<Doc<'sndsIpDailyStats'>, 'ip' | 'periodStart' | 'trapHits'>[],
	now: number
): SndsTrapHits[] {
	const freshFrom = oldestFreshDay(now);
	const newest = new Map<string, SndsTrapHits>();
	for (const row of rows) {
		if (row.periodStart < freshFrom || row.trapHits <= 0) continue;
		const seen = newest.get(row.ip);
		if (!seen || row.periodStart > seen.periodStart) {
			newest.set(row.ip, { ip: row.ip, trapHits: row.trapHits, periodStart: row.periodStart });
		}
	}
	return [...newest.values()].sort((a, b) => a.ip.localeCompare(b.ip));
}

async function readFreshSndsRows(db: QueryCtx['db'], now: number) {
	return await db
		.query('sndsIpDailyStats')
		.withIndex('by_period', (q) => q.gte('periodStart', oldestFreshDay(now)))
		.take(SNDS_STANDING_ROW_LIMIT);
}

export async function readSndsIpStandings(
	db: QueryCtx['db'],
	now: number
): Promise<SndsIpStanding[]> {
	return sndsIpStandings(await readFreshSndsRows(db, now), now);
}

/** What the Center's SNDS note shows: the filter results and the trap hits. */
export async function readSndsCenterNote(
	db: QueryCtx['db'],
	now: number
): Promise<{ standings: SndsIpStanding[]; trapHits: SndsTrapHits[] }> {
	const rows = await readFreshSndsRows(db, now);
	return { standings: sndsIpStandings(rows, now), trapHits: sndsTrapHits(rows, now) };
}

export function microsoftHeldIps(standings: readonly SndsIpStanding[]): string[] {
	return standings.filter((standing) => standing.filterResult === 'red').map(({ ip }) => ip);
}

export const getMicrosoftHeldIps = internalQuery({
	args: {},
	handler: async (ctx): Promise<string[]> =>
		microsoftHeldIps(await readSndsIpStandings(ctx.db, Date.now())),
});
