/**
 * The Microsoft SNDS poller: configuration, fetching and fan-out.
 *
 * This is the thin shell around `sndsFeed.ts` (parsing). It reads the operator's
 * configured feed URLs, fetches them defensively, folds every feed into ONE set
 * of (IP, day) observations and hands bounded batches to `snds.ts`'s idempotent
 * ingest mutation. Storage, retention and the gate read live in `snds.ts`; every
 * decision worth testing lives in the pure modules.
 *
 * D2 — ADDITIVE ONLY. No feed configured means the poller returns early having
 * written nothing and thrown nothing. A failed fetch, an unparseable body and
 * an empty day are all counted and returned, never raised: SNDS can only lower
 * measurement confidence and slow the Microsoft cell's ramp, never block it.
 */

import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { getOptional } from '../lib/env';
import {
	createSndsDayFold,
	DAY_MS,
	foldedSndsDays,
	foldSndsDays,
	parseSndsFeed,
	SNDS_MAX_FEED_BYTES,
	utcDayStart,
	type SndsDayObservation,
} from './sndsFeed';
import { parsePoolIpsLenient } from '../domains/spf';

/**
 * How far back a feed row may reach and still be stored. Shared with `snds.ts`:
 * the poller pre-filters on it so a day the mutation would refuse never costs a
 * round trip, and the mutation re-checks it because the argument is untrusted.
 */
export const SNDS_INGEST_MAX_AGE_MS = 14 * DAY_MS;
const FEED_TIMEOUT_MS = 20_000;

/** Bounds on the operator-supplied configuration and on each poll's fan-out. */
export const SNDS_MAX_FEEDS = 8;
export const SNDS_INGEST_BATCH_SIZE = 64;
/**
 * The hard ceiling on one poll's ingest fan-out (D16 — write amplification is a
 * design constraint). Every observation past it costs a `runMutation` round trip
 * carrying indexed reads and writes, and the feed decides how many there are:
 * {@link SNDS_MAX_FEEDS} feeds x `SNDS_MAX_ROWS` rows can fold to six figures of
 * (IP, day) pairs. This bounds the tick at ~32 batched mutations for a pool far
 * larger than any real deployment, and the overflow is COUNTED rather than
 * silently dropped.
 */
export const SNDS_MAX_OBSERVATIONS_PER_POLL = 2_000;

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
 * (see `snds.ts`'s `getMicrosoftGateInput`).
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
 * The zero summary — the starting point BOTH paths spread: the not-enrolled
 * return value and the enrolled poll's running tally. FROZEN: it is
 * module-level shared state, so a caller that mutated what `poll` handed back
 * would corrupt every later poll in the isolate. Callers get a copy; the freeze
 * is the belt to that's braces.
 */
const EMPTY_POLL_SUMMARY: SndsPollSummary = Object.freeze({
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

/** What `poll` returns when no feed is configured: a copy of the zero summary. */
function notEnrolledSummary(): SndsPollSummary {
	return { ...EMPTY_POLL_SUMMARY };
}

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
		if (urls.length === 0) return notEnrolledSummary();

		const allowlist = parsePoolAllowlist(getOptional('MTA_IP_POOLS'));
		const fetchedAt = Date.now();
		const summary: SndsPollSummary = { ...EMPTY_POLL_SUMMARY, enrolled: true, feeds: urls.length };
		const observations: SndsDayObservation[] = [];
		// ONE fold across ALL feeds. SNDS keys are per registered range and ranges
		// overlap, so two feeds can both report an IP-day; folding per feed would
		// dispatch that day twice and the second copy — same `fetchedAt` — would be
		// stored as a replay, silently dropping one feed's counters.
		const fold = createSndsDayFold();
		// EVERY filter the mutation would apply is applied HERE first: the round
		// trip is the expensive part of ingest, so a day we already know will be
		// refused must never be paid for (D16).
		const oldestDay = utcDayStart(fetchedAt) - SNDS_INGEST_MAX_AGE_MS;

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

		// NEWEST DAY FIRST (`foldedSndsDays`). When the fold overflows the poll cap
		// the days we drop are the OLDEST ones, never whichever addresses happen to
		// sort last — a day we never store reads later as a day with nothing wrong
		// in it, and the gate window is the newest days.
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
