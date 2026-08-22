/**
 * The bulk and offline surfaces (plan §8.3): the signed snapshot, the diff feed
 * between snapshots, and the generated DNS zone.
 *
 * These exist for lookup privacy, not for throughput. A per-message DNS or
 * HTTPS lookup tells the resolver — and everyone on the path — who is sending
 * you mail, so the reference client prefers a local snapshot plus the diff feed
 * and falls back to a live query only on a cache miss (spec 08 §8.3).
 *
 * Snapshot and diff are served exactly as the aggregator signed them: the
 * signature covers the RFC 8785 canonical form, so this layer must not
 * re-shape, re-order or annotate the document on the way out.
 *
 * Snapshot and zone are served with an entity tag over the exact bytes: they
 * are the two largest answers here, they change once per refresh, and a
 * conditional request for an unchanged one should cost a 304, not a re-send.
 * The serialized body and its tag are held alongside the value they were
 * computed from, so an unconditional request for an unchanged snapshot or zone
 * costs neither a re-serialization nor a re-hash: an aggregator hands back the
 * identical value between refreshes, and identity is the whole cache key. A
 * `ScoreIndex` that builds a fresh value per call simply never hits.
 */
import type { DiffFeedEntry, SnapshotFile } from '@owlat/ostr-core';
import type { Hono } from 'hono';
import type { ScoreIndex } from '../../contracts.js';
import { CACHE_ANSWER, CACHE_BULK, entityTag, matchesIfNoneMatch } from '../cache.js';
import { notFound } from '../errors.js';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, optionalInteger } from '../params.js';

/**
 * The bounded read of the diff feed, which the frozen {@link ScoreIndex} has no
 * signature for. An implementation that can push a page bound into its storage
 * offers this; the route prefers it and falls back to slicing when it is absent,
 * so the contract stays as it is and a fake stays as small as it is.
 */
export interface PagedDiffFeed {
	diffPage(seq: number, limit: number): Promise<DiffFeedEntry[]>;
}

function canPageDiffs(scores: ScoreIndex): scores is ScoreIndex & PagedDiffFeed {
	return typeof (scores as ScoreIndex & Partial<PagedDiffFeed>).diffPage === 'function';
}

/** One rendered body and its entity tag, keyed by the value they came from. */
interface Rendered<T> {
	source: T;
	body: string;
	etag: string;
}

function render<T>(
	cached: Rendered<T> | null,
	source: T,
	serialize: (value: T) => string
): Rendered<T> {
	if (cached !== null && cached.source === source) return cached;
	const body = serialize(source);
	return { source, body, etag: entityTag(body) };
}

export function registerDistributionRoutes(app: Hono, scores: ScoreIndex): void {
	// Per app instance, not per module: two apps in one process (the tests run
	// several) must not see each other's rendered bytes.
	let lastSnapshot: Rendered<SnapshotFile> | null = null;
	let lastZone: Rendered<string> | null = null;

	app.get('/v1/snapshot', async (c) => {
		const snapshot = await scores.snapshot();
		if (snapshot === null) throw notFound('no snapshot published yet');
		lastSnapshot = render(lastSnapshot, snapshot, (value) => JSON.stringify(value));
		const { body, etag } = lastSnapshot;
		c.header('cache-control', CACHE_BULK);
		c.header('etag', etag);
		if (matchesIfNoneMatch(c.req.header('if-none-match') ?? null, etag)) return c.body(null, 304);
		c.header('content-type', 'application/json; charset=UTF-8');
		return c.body(body, 200);
	});

	/**
	 * A page of the diff feed, oldest first. Paged for the same reason every
	 * other collection here is: `since=0` on a registry with a real scored set
	 * is otherwise a request to materialize the whole journal into one JSON
	 * string, from an anonymous caller, as often as they like. A client that
	 * wants the rest asks again with the last `seq` it saw — the resume point
	 * `syncDiff` in `@owlat/ostr-client` already returns as `latestSeq`.
	 */
	app.get('/v1/diff', async (c) => {
		const since = optionalInteger(c, 'since', 0);
		const limit = Math.min(
			optionalInteger(c, 'limit', DEFAULT_PAGE_LIMIT, { min: 1 }),
			MAX_PAGE_LIMIT
		);
		const entries = canPageDiffs(scores)
			? await scores.diffPage(since, limit)
			: (await scores.diffSince(since)).slice(0, limit);
		// Shorter than the snapshot's: a page for a given `since` fills up as the
		// feed grows, so a long-held copy hides entries that already exist.
		c.header('cache-control', CACHE_ANSWER);
		return c.json(entries);
	});

	app.get('/v1/zone', async (c) => {
		const zone = await scores.dnsZone();
		lastZone = render(lastZone, zone, (value) => value);
		const { body, etag } = lastZone;
		c.header('cache-control', CACHE_BULK);
		c.header('etag', etag);
		if (matchesIfNoneMatch(c.req.header('if-none-match') ?? null, etag)) return c.body(null, 304);
		// The tagged bytes, so the body and the tag can never disagree.
		return c.text(body, 200, { 'content-type': 'text/plain; charset=utf-8' });
	});
}
