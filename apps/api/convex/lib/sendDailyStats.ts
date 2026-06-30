import type { MutationCtx, DatabaseReader } from '../_generated/server';

type Field = 'sent' | 'delivered' | 'opened' | 'clicked';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Write-shard count per (date) bucket. Each event picks a random shard and bumps
 * only that row, so an N-recipient blast spreads its read-modify-writes across
 * SHARD_COUNT daily rows instead of contending on a single deployment-wide
 * today-row (a Convex OCC hotspot, since this is bumped inline on every
 * sent/delivered/opened/clicked event for both campaign and transactional
 * sends). `readDailyStats` sums across shards, so the split is invisible to
 * readers. Mirrors the `sendingReputation` shard idiom (ADR-0042).
 */
const SHARD_COUNT = 16;

/**
 * Format a UTC timestamp as 'YYYY-MM-DD'. Every row must use the same UTC bucket
 * regardless of the writer's locale; ISO date strings also sort chronologically,
 * so the by_date index supports a `gte(cutoff)` window read.
 */
function utcDate(at: number): string {
	const d = new Date(at);
	const yyyy = d.getUTCFullYear();
	const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
	const dd = String(d.getUTCDate()).padStart(2, '0');
	return `${yyyy}-${mm}-${dd}`;
}

/**
 * Bump one counter on a random shard of today's `sendDailyStats`, inserting the
 * shard row on its first event. Called from the Send lifecycle `daily_stats_bump`
 * effect; both campaign and transactional kinds funnel through here. The random
 * shard spreads concurrent per-event RMWs across SHARD_COUNT rows instead of
 * contending on one. Deliberately NOT lib/statShards.bumpStatShard: that seam
 * hard-codes STAT_SHARD_COUNT=8 and per-entity shard rows, while this table
 * shards per-DATE at 16 — adapting the seam would change both contracts for
 * zero deduplication of actual logic beyond the four-line bump. (Mutations may use Math.random; only the workflow runtime
 * forbids it.)
 */
export async function bumpSendDailyStat(
	ctx: MutationCtx,
	field: Field,
	at: number,
): Promise<void> {
	const date = utcDate(at);
	const shardKey = Math.floor(Math.random() * SHARD_COUNT);
	const existing = await ctx.db
		.query('sendDailyStats')
		.withIndex('by_date_shard', (q) => q.eq('date', date).eq('shardKey', shardKey))
		.unique();

	if (existing) {
		await ctx.db.patch(existing._id, {
			[field]: (existing[field] ?? 0) + 1,
		});
		return;
	}

	await ctx.db.insert('sendDailyStats', {
		date,
		shardKey,
		sent: field === 'sent' ? 1 : 0,
		delivered: field === 'delivered' ? 1 : 0,
		opened: field === 'opened' ? 1 : 0,
		clicked: field === 'clicked' ? 1 : 0,
	});
}

export interface DailyStatRow {
	date: string;
	sent: number;
	delivered: number;
	opened: number;
	clicked: number;
}

/**
 * Read the last `days` UTC days of daily send stats, summed across shards per
 * date, oldest-first. The single reader-side seam that makes the shard split
 * invisible. Bounded: at most `days` × SHARD_COUNT small rows.
 */
export async function readDailyStats(
	db: DatabaseReader,
	days: number,
	now: number,
): Promise<DailyStatRow[]> {
	// `days - 1`: the inclusive `gte(cutoff)` date-string range spans the cutoff
	// day through today, so subtracting `days` would cover `days + 1` calendar days.
	const cutoff = utcDate(now - (days - 1) * DAY_MS);
	// bounded: `days` × SHARD_COUNT shard rows within the window.
	const rows = await db
		.query('sendDailyStats')
		.withIndex('by_date', (q) => q.gte('date', cutoff))
		.collect();

	const byDate = new Map<string, DailyStatRow>();
	for (const r of rows) {
		let agg = byDate.get(r.date);
		if (!agg) {
			agg = { date: r.date, sent: 0, delivered: 0, opened: 0, clicked: 0 };
			byDate.set(r.date, agg);
		}
		agg.sent += r.sent;
		agg.delivered += r.delivered;
		agg.opened += r.opened;
		agg.clicked += r.clicked;
	}

	return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
