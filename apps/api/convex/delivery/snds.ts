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
	aggregateSndsDays,
	normalizeSndsIp,
	parseSndsFeed,
	SNDS_MAX_FEED_BYTES,
	type SndsDayObservation,
} from './sndsFeed';
import { buildSndsGateInput, type SndsGateInput } from './sndsGate';
import { observationVerdict } from './observationFreshness';

const DAY_MS = 24 * 60 * 60 * 1_000;
const INGEST_MAX_AGE_MS = 14 * DAY_MS;
const RETENTION_MS = 90 * DAY_MS;
const FETCHED_AT_FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;
const FEED_TIMEOUT_MS = 20_000;

/** Bounds on the operator-supplied configuration and on each poll's fan-out. */
export const SNDS_MAX_FEEDS = 8;
export const SNDS_INGEST_BATCH_SIZE = 64;
export const SNDS_CLEANUP_BATCH_SIZE = 128;
/** How many stored days one gate evaluation may read. */
export const SNDS_GATE_MAX_ROWS = 512;
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
		const candidate = entry.trim();
		if (candidate.length === 0 || urls.length >= SNDS_MAX_FEEDS) continue;
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
 * treat it as an allowlist and drop everything else; when they do not, the
 * feed's own scoping is the only bound available and we keep what it sends.
 * Unlike `domains/spf.ts:parsePoolIps` this never throws — a typo in the pool
 * must not take the poller down.
 */
export function parsePoolAllowlist(raw: string | undefined): Set<string> {
	const ips = new Set<string>();
	for (const entry of (raw ?? '').split(',')) {
		const ip = normalizeSndsIp(entry);
		if (ip !== null) ips.add(ip);
	}
	return ips;
}

export interface SndsPollSummary {
	enrolled: boolean;
	feeds: number;
	feedsFailed: number;
	observations: number;
	ingested: number;
	rejected: number;
	droppedRows: number;
	foreignIps: number;
	truncated: boolean;
}

const NOT_ENROLLED: SndsPollSummary = {
	enrolled: false,
	feeds: 0,
	feedsFailed: 0,
	observations: 0,
	ingested: 0,
	rejected: 0,
	droppedRows: 0,
	foreignIps: 0,
	truncated: false,
};

/** Fetch one feed's body, bounded in time and size. `null` on any failure. */
async function fetchFeed(url: string): Promise<string | null> {
	try {
		const response = await fetch(url, {
			signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
			headers: { accept: 'text/csv, text/plain' },
		});
		if (!response.ok) return null;
		const declaredLength = Number(response.headers.get('content-length') ?? '');
		if (Number.isFinite(declaredLength) && declaredLength > SNDS_MAX_FEED_BYTES) return null;
		const body = await response.text();
		// The row cap in the parser bounds the rest; this bounds the string.
		return body.length > SNDS_MAX_FEED_BYTES ? body.slice(0, SNDS_MAX_FEED_BYTES) : body;
	} catch {
		return null;
	}
}

export const poll = internalAction({
	args: {},
	handler: async (ctx): Promise<SndsPollSummary> => {
		const urls = parseSndsFeedUrls(getOptional('SNDS_DATA_FEED_URLS'));
		// D2: not enrolled is a supported configuration. Return, write nothing.
		if (urls.length === 0) return NOT_ENROLLED;

		const allowlist = parsePoolAllowlist(getOptional('MTA_IP_POOLS'));
		const fetchedAt = Date.now();
		const summary: SndsPollSummary = { ...NOT_ENROLLED, enrolled: true, feeds: urls.length };
		const observations: SndsDayObservation[] = [];

		for (const url of urls) {
			const body = await fetchFeed(url);
			if (body === null) {
				summary.feedsFailed += 1;
				continue;
			}
			const parsed = parseSndsFeed(body);
			summary.droppedRows += parsed.dropped;
			summary.truncated ||= parsed.truncated;
			for (const day of aggregateSndsDays(parsed.rows)) {
				if (allowlist.size > 0 && !allowlist.has(day.ip)) {
					summary.foreignIps += 1;
					continue;
				}
				observations.push(day);
			}
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
function isCount(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function isStorableObservation(
	now: number,
	fetchedAt: number,
	observation: {
		ip: string;
		periodStart: number;
		trapHits: number;
		messageRecipients: number;
		rcptCommands: number;
		dataCommands: number;
	}
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
		isCount(observation.trapHits) &&
		isCount(observation.messageRecipients) &&
		isCount(observation.rcptCommands) &&
		isCount(observation.dataCommands)
	);
}

/**
 * Store a batch of (IP, day) observations idempotently.
 *
 * Freshness is arbitrated exactly as the Postmaster path does it: a newer read
 * replaces the row, an identical read is an acknowledged replay, an older one
 * is refused. `replace`, not `patch`, so a value the feed stops reporting
 * disappears instead of lingering.
 */
export const ingestDays = internalMutation({
	args: { observations: v.array(observationValidator), fetchedAt: v.number() },
	handler: async (ctx, args) => {
		const now = Date.now();
		let ingested = 0;
		let rejected = 0;
		let replayed = 0;
		for (const observation of args.observations.slice(0, SNDS_INGEST_BATCH_SIZE)) {
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
			const values = {
				ip: observation.ip,
				periodStart: observation.periodStart,
				complaintBand: observation.complaintBand,
				filterResult: observation.filterResult,
				trapHits: observation.trapHits,
				messageRecipients: observation.messageRecipients,
				rcptCommands: observation.rcptCommands,
				dataCommands: observation.dataCommands,
				...(observation.sampleHelo !== undefined ? { sampleHelo: observation.sampleHelo } : {}),
				fetchedAt: args.fetchedAt,
				ingestedAt: now,
			};
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
	handler: async (ctx) => {
		const horizon = Date.now() - RETENTION_MS;
		const expired = await ctx.db
			.query('sndsIpDailyStats')
			.withIndex('by_period', (q) => q.lt('periodStart', horizon))
			.take(SNDS_CLEANUP_BATCH_SIZE);
		for (const row of expired) await ctx.db.delete(row._id);
		const hasMore = expired.length === SNDS_CLEANUP_BATCH_SIZE;
		if (hasMore) await ctx.scheduler.runAfter(0, internal.delivery.snds.cleanup, {});
		return { deleted: expired.length, continuationScheduled: hasMore };
	},
});

/**
 * Gate 3's input for the Microsoft cell.
 *
 * Returns `available: false` with the documented substitution when the
 * operator never enrolled OR when the window is empty — the caller treats both
 * the same way, which is the point of the substitution table.
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
		const rows = await ctx.db
			.query('sndsIpDailyStats')
			.withIndex('by_period', (q) => q.gte('periodStart', cutoff))
			.take(SNDS_GATE_MAX_ROWS); // bounded: pool IPs x window days
		return buildSndsGateInput({
			enrolled,
			windowDays,
			observations: rows.map((row) => ({
				ip: row.ip,
				periodStart: row.periodStart,
				complaintBand: row.complaintBand,
				filterResult: row.filterResult,
				trapHits: row.trapHits,
			})),
		});
	},
});
