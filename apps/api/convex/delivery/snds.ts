/**
 * Microsoft SNDS ingestion, retention and gate input.
 *
 * The poller is the thin shell around `sndsFeed.ts` (parsing) and
 * `sndsGate.ts` (the decision): it reads the operator's configured feed URLs,
 * fetches them defensively, and hands the parsed observations to an idempotent
 * mutation. Every decision worth testing lives in the two pure modules.
 *
 * D2 — ADDITIVE ONLY. No feed configured means the poller returns early having
 * written nothing and thrown nothing. A failed fetch, an unparseable body and
 * an empty day are all counted and returned, never raised: SNDS can only lower
 * measurement confidence and slow the Microsoft cell's ramp, never block it.
 */

import { v } from 'convex/values';
import { internalAction, internalMutation, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
import { getOptional } from '../lib/env';
import { sndsComplaintBandValidator, sndsFilterResultValidator } from '../schema/snds';
import {
	createSndsDayFold,
	DAY_MS,
	foldedSndsDays,
	foldSndsDays,
	normalizeSndsIp,
	parseSndsFeed,
	SNDS_MAX_FEED_BYTES,
	utcDayStart,
	type SndsDayObservation,
} from './sndsFeed';
import { buildSndsGateInput, type SndsGateInput, type SndsGateObservation } from './sndsGate';
import { parsePoolIpsLenient } from '../domains/spf';
import { observationVerdict } from './observationFreshness';
import { sweepExpiredObservations } from './observationRetention';

const INGEST_MAX_AGE_MS = 14 * DAY_MS;
const RETENTION_MS = 90 * DAY_MS;
const FETCHED_AT_FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;
const FEED_TIMEOUT_MS = 20_000;

/** Bounds on the operator-supplied configuration and on each poll's fan-out. */
export const SNDS_MAX_FEEDS = 8;
export const SNDS_INGEST_BATCH_SIZE = 64;
/**
 * The hard ceiling on one poll's ingest fan-out (D16 — write amplification is a
 * design constraint). Every observation past it costs a `runMutation` round trip
 * carrying indexed reads and writes, and the feed decides how many there are:
 * {@link SNDS_MAX_FEEDS} feeds x {@link SNDS_MAX_ROWS} rows can fold to six
 * figures of (IP, day) pairs. This bounds the tick at ~32 batched mutations for
 * a pool far larger than any real deployment, and the overflow is COUNTED rather
 * than silently dropped.
 */
export const SNDS_MAX_OBSERVATIONS_PER_POLL = 2_000;
export const SNDS_CLEANUP_BATCH_SIZE = 128;
/** How many stored days one UNSCOPED gate evaluation may read. */
export const SNDS_GATE_MAX_ROWS = 512;
/**
 * How many declared pool addresses one gate evaluation walks, and how many days
 * it reads for each. A pool-scoped read is bounded by the pool rather than by
 * the table, so it never reports `truncated` merely for having a lot of history:
 * the per-IP cap is comfortably above the 90-day retention ceiling.
 */
export const SNDS_GATE_MAX_POOL_IPS = 64;
export const SNDS_GATE_MAX_ROWS_PER_IP = 96;
export const SNDS_GATE_WINDOW_DAYS = 7;

/**
 * Parse `SNDS_DATA_FEED_URLS`.
 *
 * The value is a list of Automated Data Access URLs. Each one is a BEARER
 * CAPABILITY to the operator's SNDS data, so it is never logged or returned;
 * only `https` is accepted, and a malformed entry is ignored rather than
 * crashing the poll.
 */
export function parseSndsFeedUrls(raw: string | undefined): string[] {
	const urls: string[] = [];
	for (const entry of (raw ?? '').split(/[,\s]+/)) {
		if (urls.length >= SNDS_MAX_FEEDS) break;
		const candidate = entry.trim();
		if (candidate.length === 0) continue;
		let parsed: URL;
		try {
			parsed = new URL(candidate);
		} catch {
			continue;
		}
		if (parsed.protocol !== 'https:') continue;
		if (!urls.includes(parsed.toString())) urls.push(parsed.toString());
	}
	return urls;
}

/**
 * The sending IPs this deployment claims, from `MTA_IP_POOLS`.
 *
 * An SNDS key can cover a whole registered range, so a feed may legitimately
 * carry addresses that are not ours. When the operator declares their pool we
 * treat it as an allowlist and drop everything else; when they do not, the feed
 * is stored unattributed and the GATE refuses to read it as positive evidence
 * (see {@link getMicrosoftGateInput}).
 *
 * The grammar is `domains/spf.ts`'s, read leniently: one parser for one env var,
 * because a typo in the pool must not take the poller down but it also must not
 * mean the poller accepts addresses registration would have refused.
 */
export function parsePoolAllowlist(raw: string | undefined): Set<string> {
	return new Set(parsePoolIpsLenient(raw).ips);
}

export interface SndsPollSummary {
	enrolled: boolean;
	feeds: number;
	feedsFailed: number;
	/** Observations actually dispatched to the ingest mutation. */
	observations: number;
	ingested: number;
	rejected: number;
	/** Reads the store acknowledged as byte-identical replays of what it holds. */
	replayed: number;
	droppedRows: number;
	foreignIps: number;
	/** Days the feed reported outside the ingest window, dropped before dispatch. */
	outOfWindow: number;
	/** Observations dropped by {@link SNDS_MAX_OBSERVATIONS_PER_POLL}. */
	capped: number;
	/** Feed rows dropped because the fold hit its distinct-(IP, day) cap. */
	overflowed: number;
	truncated: boolean;
}

/**
 * The zero summary — both the not-enrolled return value and the starting point
 * the enrolled path spreads. FROZEN: it is module-level shared state, so a
 * caller that mutated what `poll` handed back would corrupt every later poll in
 * the isolate. Callers get a copy; the freeze is the belt to that's braces.
 */
const NOT_ENROLLED: SndsPollSummary = Object.freeze({
	enrolled: false,
	feeds: 0,
	feedsFailed: 0,
	observations: 0,
	ingested: 0,
	rejected: 0,
	replayed: 0,
	droppedRows: 0,
	foreignIps: 0,
	outOfWindow: 0,
	capped: 0,
	overflowed: 0,
	truncated: false,
});

/**
 * Fetch one feed's body, bounded in time and in size. `null` on any failure,
 * which the caller counts as `feedsFailed`.
 *
 * THE SIZE BOUND IS ENFORCED WHILE READING, not after. `await response.text()`
 * would materialise whatever the server chose to send before any check could
 * run, and `content-length` is a hint only a well-behaved server volunteers —
 * so the body is drained through a reader and the connection is cancelled the
 * moment it crosses {@link SNDS_MAX_FEED_BYTES}. A feed that overruns is a
 * FAILED feed, never a truncated one: half a CSV row is not evidence.
 */
async function fetchFeed(url: string): Promise<string | null> {
	try {
		const response = await fetch(url, {
			signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
			headers: { accept: 'text/csv, text/plain' },
		});
		if (!response.ok) return null;
		const declaredLength = Number(response.headers.get('content-length') ?? '');
		if (Number.isFinite(declaredLength) && declaredLength > SNDS_MAX_FEED_BYTES) return null;
		return await readBounded(response, SNDS_MAX_FEED_BYTES);
	} catch {
		return null;
	}
}

/** Drain a response body up to `maxBytes`, or `null` if it exceeds that. */
async function readBounded(response: Response, maxBytes: number): Promise<string | null> {
	const body = response.body;
	if (body === null) return '';
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let received = 0;
	let text = '';
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			const value: Uint8Array | undefined = chunk.value;
			if (value === undefined) continue;
			received += value.byteLength;
			if (received > maxBytes) {
				await reader.cancel();
				return null;
			}
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
	return text + decoder.decode();
}

export const poll = internalAction({
	args: {},
	handler: async (ctx): Promise<SndsPollSummary> => {
		const urls = parseSndsFeedUrls(getOptional('SNDS_DATA_FEED_URLS'));
		// D2: not enrolled is a supported configuration. Return, write nothing.
		if (urls.length === 0) return { ...NOT_ENROLLED };

		const allowlist = parsePoolAllowlist(getOptional('MTA_IP_POOLS'));
		const fetchedAt = Date.now();
		const summary: SndsPollSummary = { ...NOT_ENROLLED, enrolled: true, feeds: urls.length };
		const observations: SndsDayObservation[] = [];
		// ONE fold across ALL feeds. SNDS keys are per registered range and ranges
		// overlap, so two feeds can both report an IP-day; folding per feed would
		// dispatch that day twice and the second copy — same `fetchedAt` — would be
		// stored as a replay, silently dropping one feed's counters.
		const fold = createSndsDayFold();
		// EVERY filter the mutation would apply is applied HERE first: the round
		// trip is the expensive part of ingest, so a day we already know will be
		// refused must never be paid for (D16).
		const oldestDay = utcDayStart(fetchedAt) - INGEST_MAX_AGE_MS;

		for (const url of urls) {
			const body = await fetchFeed(url);
			if (body === null) {
				summary.feedsFailed += 1;
				continue;
			}
			const parsed = parseSndsFeed(body);
			summary.droppedRows += parsed.dropped;
			summary.truncated ||= parsed.truncated;
			foldSndsDays(fold, parsed.rows);
		}
		summary.overflowed = fold.overflowed;

		for (const day of foldedSndsDays(fold)) {
			if (allowlist.size > 0 && !allowlist.has(day.ip)) {
				summary.foreignIps += 1;
				continue;
			}
			if (day.periodStart < oldestDay || day.periodStart > fetchedAt) {
				summary.outOfWindow += 1;
				continue;
			}
			if (observations.length >= SNDS_MAX_OBSERVATIONS_PER_POLL) {
				summary.capped += 1;
				continue;
			}
			observations.push(day);
		}

		summary.observations = observations.length;
		for (let offset = 0; offset < observations.length; offset += SNDS_INGEST_BATCH_SIZE) {
			const batch = observations.slice(offset, offset + SNDS_INGEST_BATCH_SIZE);
			const result = await ctx.runMutation(internal.delivery.snds.ingestDays, {
				observations: batch,
				fetchedAt,
			});
			summary.ingested += result.ingested;
			summary.rejected += result.rejected;
			summary.replayed += result.replayed;
		}
		return summary;
	},
});

const observationValidator = v.object({
	ip: v.string(),
	periodStart: v.number(),
	complaintBand: sndsComplaintBandValidator,
	filterResult: sndsFilterResultValidator,
	trapHits: v.number(),
	messageRecipients: v.number(),
	rcptCommands: v.number(),
	dataCommands: v.number(),
	sampleHelo: v.optional(v.string()),
});

/** A counter that survived the wire: finite, non-negative, integral. */
function isNonNegativeSafeInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function isStorableObservation(
	now: number,
	fetchedAt: number,
	observation: SndsDayObservation
): boolean {
	return (
		normalizeSndsIp(observation.ip) === observation.ip &&
		Number.isFinite(observation.periodStart) &&
		observation.periodStart % DAY_MS === 0 &&
		observation.periodStart <= now &&
		observation.periodStart >= now - INGEST_MAX_AGE_MS &&
		Number.isFinite(fetchedAt) &&
		fetchedAt >= observation.periodStart &&
		fetchedAt <= now + FETCHED_AT_FUTURE_TOLERANCE_MS &&
		isNonNegativeSafeInteger(observation.trapHits) &&
		isNonNegativeSafeInteger(observation.messageRecipients) &&
		isNonNegativeSafeInteger(observation.rcptCommands) &&
		isNonNegativeSafeInteger(observation.dataCommands)
	);
}

/**
 * Store a batch of (IP, day) observations idempotently.
 *
 * Freshness is arbitrated exactly as the Postmaster path does it: a newer read
 * replaces the row, an identical read is an acknowledged replay, an older one
 * is refused. `replace`, not `patch`, so a value the feed stops reporting
 * disappears instead of lingering.
 *
 * BATCHING IS THE CALLER'S CONTRACT. `poll` slices at
 * {@link SNDS_INGEST_BATCH_SIZE} before it calls, and it is the only caller. A
 * second cap here would be a seam with no user (D20) and — since the argument
 * validator cannot bound an array's length — it would not protect the
 * transaction from a large argument anyway, only from a large loop.
 */
export const ingestDays = internalMutation({
	args: { observations: v.array(observationValidator), fetchedAt: v.number() },
	handler: async (ctx, args) => {
		const now = Date.now();
		let ingested = 0;
		let rejected = 0;
		let replayed = 0;
		for (const observation of args.observations) {
			if (!isStorableObservation(now, args.fetchedAt, observation)) {
				rejected += 1;
				continue;
			}
			const existing = await ctx.db
				.query('sndsIpDailyStats')
				.withIndex('by_ip_period', (q) =>
					q.eq('ip', observation.ip).eq('periodStart', observation.periodStart)
				)
				.unique();
			const verdict = observationVerdict(existing?.fetchedAt, args.fetchedAt);
			if (verdict !== 'write') {
				if (verdict === 'replayed') replayed += 1;
				else rejected += 1;
				continue;
			}
			// Spread the validated observation: it IS the row's shape, so respelling
			// its eight fields here would be a fourth place to keep them in step.
			const values = { ...observation, fetchedAt: args.fetchedAt, ingestedAt: now };
			if (existing) await ctx.db.replace(existing._id, values);
			else await ctx.db.insert('sndsIpDailyStats', values);
			ingested += 1;
		}
		// `rejected` counts refusals, not failures: the caller logs a number, and
		// nothing here throws, because the feed is internet-supplied input.
		return { ingested, rejected, replayed };
	},
});

export const cleanup = internalMutation({
	args: {},
	handler: async (ctx) =>
		sweepExpiredObservations(ctx, {
			now: Date.now(),
			retentionMs: RETENTION_MS,
			batchSize: SNDS_CLEANUP_BATCH_SIZE,
			scans: [
				(horizon, limit) =>
					ctx.db
						.query('sndsIpDailyStats')
						.withIndex('by_period', (q) => q.lt('periodStart', horizon))
						.take(limit),
			],
			scheduleContinuation: () => ctx.scheduler.runAfter(0, internal.delivery.snds.cleanup, {}),
		}),
});

/**
 * Gate 3's input for the Microsoft cell.
 *
 * Returns `available: false` with the documented substitution when the
 * operator never enrolled OR when the window is empty — the caller treats both
 * the same way, which is the point of the substitution table.
 *
 * THE READ IS SCOPED THE WAY THE INGEST IS SCOPED. An SNDS key is issued per
 * REGISTERED RANGE, so the table can legitimately hold days belonging to other
 * senders in that range — the poller only drops them when the operator has
 * declared `MTA_IP_POOLS`, and rows ingested before they declared it stay for
 * the full retention. Folding those in would let a neighbour's clean band
 * satisfy OUR promotion criterion, because the worst-of fold only protects the
 * DOWN direction. So: with a declared pool the query walks the pool and reads
 * nothing else; with no declared pool the window is read whole but marked
 * UNATTRIBUTED, which caps confidence at `low` and makes promotion impossible
 * while leaving pass/fail — and therefore every ability to slow the ramp —
 * exactly as it was. D2 holds: nothing here blocks, errors or nags.
 */
export const getMicrosoftGateInput = internalQuery({
	args: { windowDays: v.optional(v.number()) },
	handler: async (ctx, args): Promise<SndsGateInput> => {
		const windowDays =
			args.windowDays !== undefined && Number.isFinite(args.windowDays) && args.windowDays > 0
				? Math.min(Math.floor(args.windowDays), 90)
				: SNDS_GATE_WINDOW_DAYS;
		const enrolled = parseSndsFeedUrls(getOptional('SNDS_DATA_FEED_URLS')).length > 0;
		if (!enrolled) return buildSndsGateInput({ enrolled, windowDays, observations: [] });

		const cutoff = Date.now() - windowDays * DAY_MS;
		const pool = [...parsePoolAllowlist(getOptional('MTA_IP_POOLS'))].sort();
		const observations: SndsGateObservation[] = [];
		let truncated = false;

		if (pool.length === 0) {
			// NEWEST FIRST. The read is capped, and an ascending scan spends the cap on
			// the OLDEST days — so above ~73 stored IPs a red filter result recorded
			// today is exactly the row that falls off the end, and the gate answers
			// `pass` from a window that no longer contains the breach. Descending keeps
			// today's evidence inside the cap, and `truncated` then tells the gate that
			// what it did NOT see must never be read as cleanliness.
			const rows = await ctx.db
				.query('sndsIpDailyStats')
				.withIndex('by_period', (q) => q.gte('periodStart', cutoff))
				.order('desc')
				.take(SNDS_GATE_MAX_ROWS);
			truncated = rows.length >= SNDS_GATE_MAX_ROWS;
			for (const row of rows) observations.push(projectGateObservation(row));
			return buildSndsGateInput({
				enrolled,
				windowDays,
				truncated,
				attributed: false,
				observations,
			});
		}

		// A pool larger than this reads as truncated rather than as a long query:
		// the window is then a subset, which the gate already knows how to hold.
		truncated = pool.length > SNDS_GATE_MAX_POOL_IPS;
		for (const ip of pool.slice(0, SNDS_GATE_MAX_POOL_IPS)) {
			const rows = await ctx.db
				.query('sndsIpDailyStats')
				.withIndex('by_ip_period', (q) => q.eq('ip', ip).gte('periodStart', cutoff))
				.order('desc')
				.take(SNDS_GATE_MAX_ROWS_PER_IP);
			if (rows.length >= SNDS_GATE_MAX_ROWS_PER_IP) truncated = true;
			for (const row of rows) observations.push(projectGateObservation(row));
		}
		return buildSndsGateInput({ enrolled, windowDays, truncated, observations });
	},
});

function projectGateObservation(row: {
	ip: string;
	periodStart: number;
	complaintBand: SndsGateObservation['complaintBand'];
	filterResult: SndsGateObservation['filterResult'];
	trapHits: number;
}): SndsGateObservation {
	return {
		ip: row.ip,
		periodStart: row.periodStart,
		complaintBand: row.complaintBand,
		filterResult: row.filterResult,
		trapHits: row.trapHits,
	};
}
