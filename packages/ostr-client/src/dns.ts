/**
 * The DNS tier lookup (spec 08 §8.1): build the query name, resolve it with an
 * injected resolver, parse the single TXT answer with the shared parser from
 * `@owlat/ostr-core`.
 *
 * The resolver is a function argument, never `node:dns`. That keeps this
 * package pure and testable, and it lets an MTA hand in whatever resolver it
 * already trusts — a DNSSEC-validating stub is the point of the signed zone,
 * and this library must not quietly bypass it.
 *
 * Nothing here is the preferred lookup path. See {@link OstrClient}: DNS
 * queries leak the sender map and are a fallback for snapshot misses only.
 */

import {
	domainQueryName,
	ipQueryName,
	parseDnsTierAnswer,
	type DnsTierAnswer,
	type SubjectRef,
} from '@owlat/ostr-core';
import { canonicalIp, normalizeDomainName } from './subject.js';

/**
 * A TXT answer that carries the record's own TTL.
 *
 * Spec 08 §8.1: "A client MUST honour TTLs and MUST NOT pin answers past
 * them." `dns.promises.resolveTxt` throws the TTL away, so a resolver that has
 * it — a raw DNS library, a caching layer, `dns.promises.Resolver` wrapped by
 * the deployment — hands it over in this shape instead of the bare array, and
 * {@link OstrClient} then caches for `min(recordTtl, cacheTtlSeconds)`. An
 * adapter that cannot supply a TTL keeps returning `string[][]`, and the
 * client's configured TTL applies as before.
 */
export interface TxtRecordSet {
	records: string[][];
	/** Seconds. Omit when the resolver does not expose it. */
	ttlSeconds?: number;
}

/**
 * Resolves TXT records for `name`. One array per record, one string per
 * character-string chunk of that record (the shape `dns.promises.resolveTxt`
 * returns), because a TXT record over 255 bytes arrives split and the chunks
 * are concatenated without a separator. A {@link TxtRecordSet} may be returned
 * instead, to carry the record TTL.
 *
 * An adapter SHOULD resolve to `[]` for NXDOMAIN. Rejections carrying a node
 * `code` of `ENOTFOUND`/`ENODATA`/`NXDOMAIN` are read as "no answer" too, so
 * the stock node resolver can be passed in unwrapped.
 */
export type ResolveTxt = (name: string) => Promise<string[][] | TxtRecordSet>;

export interface DnsTierLookupInput {
	subject: SubjectRef;
	/** Aggregator zone apex, e.g. `ostr.example`. */
	zone: string;
	resolveTxt: ResolveTxt;
}

/**
 * A lookup outcome. `not-found` is a fact about the subject (no evidence, or
 * the aggregator answers NXDOMAIN); `error` is a fact about the lookup, and a
 * caller MUST NOT read it as "unknown sender".
 *
 * The distinction survives the facade: {@link OstrClient.resolveTier} returns
 * the same three statuses, and only the convenience wrapper
 * {@link OstrClient.tier} — which a caller reaches for when it is going to
 * treat "no answer" and "could not ask" alike anyway — collapses them to
 * `null`.
 */
export type DnsTierLookupResult =
	| { status: 'answer'; name: string; answer: DnsTierAnswer; ttlSeconds?: number }
	| { status: 'not-found'; name: string }
	| { status: 'error'; name: string; errors: string[] };

const NOT_FOUND_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'NOTFOUND']);

function errorCode(error: unknown): string | null {
	if (typeof error !== 'object' || error === null) return null;
	const code = (error as { code?: unknown }).code;
	return typeof code === 'string' ? code : null;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/**
 * The query name for a subject, or `null` when the reference names neither a
 * domain nor an address. A subject carrying both is queried by domain: the
 * domain is the primary identity (plan D2), and the aggregator's pair evidence
 * is folded into it.
 */
export function tierQueryName(subject: SubjectRef, zone: string): string | null {
	const domain = normalizeDomainName(subject.domain);
	if (domain !== null) return domainQueryName(domain, zone);
	const ip = canonicalIp(subject.ip);
	if (ip === null) return null;
	// `canonicalIp` already proved the literal parses, so this cannot throw.
	return ipQueryName(ip.literal, zone);
}

/** Concatenate the character-string chunks of one TXT record (RFC 1035 §3.3.14). */
export function joinTxtChunks(record: readonly string[]): string {
	return record.join('');
}

/**
 * Resolve and parse the tier answer for `subject`.
 *
 * The mono-record rule of spec 08 §8.1 is enforced rather than papered over:
 * when several TXT records at one name parse as tier answers, the answer is
 * ambiguous and this returns `error`. Picking one would let anything that can
 * add a record to the name choose which answer a receiver acts on.
 */
export async function lookupTierViaDns(input: DnsTierLookupInput): Promise<DnsTierLookupResult> {
	const name = tierQueryName(input.subject, input.zone);
	if (name === null) {
		return {
			status: 'error',
			name: '',
			errors: ['subject names neither a domain nor a parseable IP'],
		};
	}

	let answered: string[][] | TxtRecordSet;
	try {
		answered = await input.resolveTxt(name);
	} catch (error: unknown) {
		const code = errorCode(error);
		if (code !== null && NOT_FOUND_CODES.has(code)) return { status: 'not-found', name };
		return { status: 'error', name, errors: [`resolver failed: ${errorMessage(error)}`] };
	}

	const { records, ttlSeconds } = normalizeTxtAnswer(answered);
	if (records.length === 0) return { status: 'not-found', name };

	const answers: DnsTierAnswer[] = [];
	const errors: string[] = [];
	for (const [position, record] of records.entries()) {
		const parsed = parseDnsTierAnswer(joinTxtChunks(record));
		if (parsed.ok) answers.push(parsed.answer);
		else for (const message of parsed.errors) errors.push(`record ${position}: ${message}`);
	}

	const answer = answers[0];
	if (answer === undefined) return { status: 'error', name, errors };
	if (answers.length > 1) {
		return {
			status: 'error',
			name,
			errors: [`expected one TXT answer, got ${answers.length} (spec 08 §8.1)`],
		};
	}
	return ttlSeconds === undefined
		? { status: 'answer', name, answer }
		: { status: 'answer', name, answer, ttlSeconds };
}

/** Accept either resolver shape, and ignore a TTL that is not a usable number. */
function normalizeTxtAnswer(answered: string[][] | TxtRecordSet): {
	records: string[][];
	ttlSeconds: number | undefined;
} {
	if (Array.isArray(answered)) return { records: answered, ttlSeconds: undefined };
	const records = Array.isArray(answered.records) ? answered.records : [];
	const ttl = answered.ttlSeconds;
	const usable = typeof ttl === 'number' && Number.isFinite(ttl) && ttl >= 0;
	return { records, ttlSeconds: usable ? Math.floor(ttl) : undefined };
}
