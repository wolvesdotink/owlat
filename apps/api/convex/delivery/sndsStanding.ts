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
 */

import type { Doc } from '../_generated/dataModel';
import { internalQuery, type ActionCtx, type QueryCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { utcDayStart } from '../lib/clock';
import { DAY_MS } from '../lib/constants';
import { getMtaConfig, mtaFetch } from '../mail/mtaClient';

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

/** The fresh red or yellow addresses, newest reading per address. */
export function sndsIpStandings(rows: readonly StandingRow[], now: number): SndsIpStanding[] {
	const oldestFreshDay = utcDayStart(now) - (SNDS_STANDING_FRESH_DAYS - 1) * DAY_MS;
	const newest = new Map<string, StandingRow>();
	for (const row of rows) {
		if (row.periodStart < oldestFreshDay || row.filterResult === 'unknown') continue;
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

export async function readSndsIpStandings(
	db: QueryCtx['db'],
	now: number
): Promise<SndsIpStanding[]> {
	const oldestFreshDay = utcDayStart(now) - (SNDS_STANDING_FRESH_DAYS - 1) * DAY_MS;
	const rows = await db
		.query('sndsIpDailyStats')
		.withIndex('by_period', (q) => q.gte('periodStart', oldestFreshDay))
		.take(SNDS_STANDING_ROW_LIMIT);
	return sndsIpStandings(rows, now);
}

export function microsoftHeldIps(standings: readonly SndsIpStanding[]): string[] {
	return standings.filter((standing) => standing.filterResult === 'red').map(({ ip }) => ip);
}

export const getMicrosoftHeldIps = internalQuery({
	args: {},
	handler: async (ctx): Promise<string[]> =>
		microsoftHeldIps(await readSndsIpStandings(ctx.db, Date.now())),
});

/**
 * Hand the MTA the full list of held addresses, replacing the last one. An
 * empty list lifts every hold. A failed push is left to the next poll: the
 * MTA's list expires on its own, so a lost update cannot hold mail for long.
 */
export async function pushMicrosoftHolds(ctx: ActionCtx): Promise<void> {
	const mta = getMtaConfig();
	if (!mta) return;
	const ips: string[] = await ctx.runQuery(internal.delivery.sndsStanding.getMicrosoftHeldIps, {});
	try {
		await mtaFetch(mta, '/provider-holds', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider: 'microsoft', ips }),
		});
	} catch {
		// The MTA is unreachable; the next poll pushes again.
	}
}
