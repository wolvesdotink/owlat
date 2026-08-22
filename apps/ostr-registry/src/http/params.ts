/**
 * Strict parsing of everything a caller controls: the `:subject` path segment
 * and every query parameter (plan §8.2).
 *
 * Strict means three things, and each of them is a rejection some registry API
 * would rather have papered over:
 *
 * - A number is `^\d+$` and inside its declared bounds. `10.0`, `1e3`, `0x10`,
 *   ` 10`, `+10` and `-1` are errors, not values silently coerced by `Number`.
 * - A parameter given twice is an error. `?limit=10&limit=1000` has no obvious
 *   reading, and picking one silently is how a cache and an origin end up
 *   disagreeing about what was asked.
 * - A subject is a lowercase FQDN, an IPv4 literal, or a *canonical* (RFC 5952)
 *   IPv6 literal — the identity forms `@owlat/ostr-core` accepts inside an
 *   attestation. Anything else cannot name a scored subject, so it is a 400
 *   rather than a lookup that answers 404 for a spelling reason.
 *
 * Unknown query parameters are ignored: a cache-busting `?_=…` is not an
 * attack, and rejecting it would break intermediaries for no gain.
 */
import { isFqdn, isIpv4, isIpv6, parseHash, type SubjectRef } from '@owlat/ostr-core';
import type { Context } from 'hono';
import { badRequest } from './errors.js';

/** Ceiling on any page size the API serves. */
export const MAX_PAGE_LIMIT = 100;
/** Page size used when `limit` is omitted. */
export const DEFAULT_PAGE_LIMIT = 50;

const NON_NEGATIVE_INTEGER = /^\d+$/;

export interface IntegerBounds {
	min?: number;
	max?: number;
}

/**
 * The one value of `name`, or `undefined`. Throws when the caller supplied it
 * more than once.
 */
export function singleQuery(c: Context, name: string): string | undefined {
	const values = c.req.queries(name);
	if (values === undefined || values.length === 0) return undefined;
	if (values.length > 1) throw badRequest(`${name} must be given at most once`);
	return values[0];
}

function parseInteger(name: string, raw: string, bounds: IntegerBounds): number {
	if (!NON_NEGATIVE_INTEGER.test(raw)) {
		throw badRequest(`${name} must be a non-negative integer`);
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value)) {
		throw badRequest(`${name} is out of the safe integer range`);
	}
	const min = bounds.min ?? 0;
	if (value < min) throw badRequest(`${name} must be at least ${min}`);
	if (bounds.max !== undefined && value > bounds.max) {
		throw badRequest(`${name} must be at most ${bounds.max}`);
	}
	return value;
}

/** A required integer query parameter. */
export function requireInteger(c: Context, name: string, bounds: IntegerBounds = {}): number {
	const raw = singleQuery(c, name);
	if (raw === undefined || raw === '') throw badRequest(`${name} is required`);
	return parseInteger(name, raw, bounds);
}

/** An optional integer query parameter; `fallback` when absent. */
export function optionalInteger(
	c: Context,
	name: string,
	fallback: number,
	bounds: IntegerBounds = {}
): number {
	const raw = singleQuery(c, name);
	if (raw === undefined) return fallback;
	if (raw === '') throw badRequest(`${name} must not be empty`);
	return parseInteger(name, raw, bounds);
}

/**
 * A required integer that the caller may spell either as `name` or as the
 * deprecated `alias`. Supplying both is an error rather than a precedence rule:
 * two spellings of one coordinate with different values has no honest reading.
 */
export function requireAliasedInteger(
	c: Context,
	name: string,
	alias: string,
	bounds: IntegerBounds = {}
): number {
	const legacy = singleQuery(c, alias);
	if (legacy === undefined) return requireInteger(c, name, bounds);
	if (singleQuery(c, name) !== undefined) {
		throw badRequest(`${name} and ${alias} must not both be given`);
	}
	if (legacy === '') throw badRequest(`${alias} must not be empty`);
	return parseInteger(alias, legacy, bounds);
}

/**
 * An optional lowercase sha256 digest in hex — the spelling a leaf hash has
 * everywhere else in the system (spec 05 §5.2's inclusion promise, the STH's
 * `rootHash`). Uppercase is rejected rather than folded: one digest gets one
 * spelling, or a cache holds two entries for one answer.
 */
export function optionalHash(c: Context, name: string): string | undefined {
	const raw = singleQuery(c, name);
	if (raw === undefined) return undefined;
	if (raw === '') throw badRequest(`${name} must not be empty`);
	if (parseHash(raw) === undefined) {
		throw badRequest(`${name} must be a lowercase sha256 digest in hex`);
	}
	return raw;
}

/**
 * `offset`/`limit` for the paginated collections. An out-of-bounds `limit` is
 * clamped to {@link MAX_PAGE_LIMIT} rather than rejected — a client asking for
 * more than the API serves gets the maximum page, which is what every
 * pagination client expects — but a `limit` of `0` or a non-integer is a
 * mistake with no defensible reading, and is rejected.
 */
export function pagination(c: Context): { offset: number; limit: number } {
	const offset = optionalInteger(c, 'offset', 0);
	const limit = optionalInteger(c, 'limit', DEFAULT_PAGE_LIMIT, { min: 1 });
	return { offset, limit: Math.min(limit, MAX_PAGE_LIMIT) };
}

/**
 * The `:subject` path segment as a {@link SubjectRef}. Hono has already
 * percent-decoded it, which is what makes `2001%3Adb8%3A%3A1` addressable.
 *
 * The segment is taken exactly as given — surrounding whitespace is a
 * rejection, not something to trim away. Trimming would make
 * `/v1/subject/%20sender.example` a second URL for one subject, and two URLs
 * for one answer is how a cache and an origin end up disagreeing.
 */
export function parseSubject(raw: string): SubjectRef {
	if (raw === '') throw badRequest('subject must not be empty');
	if (isIpv4(raw) || isIpv6(raw)) return { ip: raw };
	if (isFqdn(raw)) return { domain: raw };
	throw badRequest(
		'subject must be a lowercase FQDN, an IPv4 literal, or a canonical IPv6 literal'
	);
}
