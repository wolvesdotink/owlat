/**
 * Cache directives and entity tags for the public surfaces (spec 08 §8.1's
 * TTL discipline, applied to the HTTPS view).
 *
 * Every answer here is public, anonymous data, and the whole point of the
 * snapshot and zone surfaces is that a receiver can run from a copy — so they
 * are exactly what an operator wants a CDN or reverse proxy to hold. The
 * directives are chosen per surface, from what the data actually promises:
 *
 * - A proof for a fixed `(index, size)` pair can never change: the tree is
 *   append-only, so the audit path against a given size is permanent.
 * - A snapshot, a zone and a score change on the aggregator's refresh cadence,
 *   so they get a short shared TTL rather than a permanent one.
 * - A signed tree head is the freshness signal a monitor is checking; a cached
 *   one would mask a stalled log, which is the failure it exists to expose.
 * - Anything else — errors included — is `no-store`, applied by `app.ts` to any
 *   response that did not choose a directive, so a new route cannot become
 *   accidentally cacheable by omission.
 */
import { createHash } from 'node:crypto';

/** Permanent: the answer is a function of coordinates the log cannot revise. */
export const CACHE_IMMUTABLE = 'public, max-age=86400, immutable';
/** Bulk surfaces that change on the aggregator's refresh cadence. */
export const CACHE_BULK = 'public, max-age=300';
/** Per-subject answers: short enough that a re-score is visible within minutes. */
export const CACHE_ANSWER = 'public, max-age=60';
/** Freshness-critical or non-cacheable. */
export const CACHE_NONE = 'no-store';

/**
 * A strong entity tag over the exact bytes served. Strong (unquoted-weak) is
 * correct here: the tag is computed from the response body itself, so two
 * responses sharing a tag are byte-identical.
 */
export function entityTag(body: string): string {
	return `"${createHash('sha256').update(body, 'utf8').digest('base64url')}"`;
}

/**
 * Whether an `If-None-Match` header matches `etag` (RFC 9110 §13.1.2): `*`
 * matches any existing representation, otherwise any tag in the list matches.
 * A `W/` prefix is stripped before comparison — a weak comparison is the one
 * RFC 9110 mandates for `If-None-Match`.
 */
export function matchesIfNoneMatch(header: string | null, etag: string): boolean {
	if (header === null || header === '') return false;
	if (header.trim() === '*') return true;
	return header
		.split(',')
		.map((candidate) => candidate.trim().replace(/^W\//, ''))
		.includes(etag);
}
