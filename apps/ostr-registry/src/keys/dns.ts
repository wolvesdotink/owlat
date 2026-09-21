/**
 * `_ostr.<domain>` key discovery over DNS (plan §5, spec 05 §5.1): the
 * production {@link KeyDirectory}.
 *
 * Discovery rides on DNS exactly as DKIM's does, so there is no PKI to run and
 * rotation is "publish the new record beside the old one". This class is the
 * thin operational shell around that: it resolves, it keeps parsing honest by
 * running every answer through `parseOstrKeyRecord`, and it caches.
 *
 * INJECTED, NOT IMPORTED. The resolver is a required constructor argument and
 * the clock is an optional one: this module never imports `node:dns`, and the
 * `Date.now` below is the default for an argument, not a call this class makes
 * on its own behalf. The composition root passes `resolveTxt` from
 * `node:dns/promises`, and a test passes a map and a counter.
 *
 * THE CACHE IS A DEFENCE, NOT AN OPTIMIZATION. Submission is open to the world
 * and the observer name in a submission is attacker-chosen, so every uncached
 * miss is a lookup someone else asked us to make against a third party's
 * nameservers. Hence four bounds:
 *
 * - a positive TTL, so a busy observer is resolved once per period;
 * - a shorter negative TTL, so a name that publishes nothing is not re-queried
 *   per submission and a real publication still appears within a minute;
 * - a hard entry cap, so a flood of one-shot observer names cannot grow the
 *   cache without limit. Eviction is oldest-first: this is a working set, not
 *   a store, and a wrongly evicted name costs one lookup.
 * - a hard cap on CONCURRENT lookups. The three above bound repetition of one
 *   name; none of them bounds `<random>.victim.example` × N, which is a fresh
 *   miss every time and costs an attacker one throwaway keypair. Past the cap
 *   the query is not issued at all: {@link KeyLookupOverloadError} is thrown,
 *   the composition root answers 503 with `Retry-After`, and an honest
 *   submitter retries. Dropping our own submission is the correct end of that
 *   trade — the alternative is being someone's DNS amplifier.
 *
 * Concurrent misses for one name are coalesced into a single in-flight query
 * for the same reason — a thousand simultaneous submissions naming one observer
 * are one question, and joining one already in flight is never refused.
 *
 * AN OUTAGE IS NOT AN ANSWER. `ENOTFOUND`/`ENODATA` mean the domain published
 * nothing: a definite negative, cached, and the log turns it into a 422
 * `unknown observer key`. Every other failure (SERVFAIL, timeout, refused)
 * propagates, so the HTTP layer answers 500 and the submitter retries. Caching
 * a resolver outage as "no keys" would reject an honest observer's evidence for
 * the length of the TTL and record that rejection nowhere.
 */
import { ostrKeyRecordName, parseOstrKeyRecord } from '@owlat/ostr-core';
import type { KeyDirectory } from '../contracts.js';
import { normalizeObserverDomain } from './static.js';

/** A TXT resolver: `node:dns/promises`' `resolveTxt`, or a fake. */
export type ResolveTxt = (name: string) => Promise<string[][]>;

/** How long a name that published usable keys is trusted without re-asking. */
export const DEFAULT_KEY_TTL_MS = 300_000;

/**
 * How long "this name publishes no usable key" is remembered. Short on
 * purpose: it is the window in which a newly-publishing observer's submissions
 * are still rejected.
 */
export const DEFAULT_NEGATIVE_TTL_MS = 60_000;

/** Cache entry ceiling; the oldest entry is dropped when a new one overflows it. */
export const DEFAULT_MAX_CACHED_DOMAINS = 10_000;

/**
 * How many distinct names may be resolved at once. Sized as a working set of
 * legitimately-unseen observers, not as a throughput target: past it, the
 * bottleneck is someone else's nameserver and this node is the thing pointing
 * traffic at it.
 */
export const DEFAULT_MAX_CONCURRENT_LOOKUPS = 32;

/**
 * Thrown instead of issuing a lookup when too many are already in flight.
 *
 * A load condition, not a fault and not a rejection of the submission: the
 * bytes may be perfectly good and a retry will work, which is why the HTTP
 * answer is a 503 with `Retry-After` rather than a 422 or a 500.
 */
export class KeyLookupOverloadError extends Error {
	/** Marks this as a retry-later condition for any layer that does not import the class. */
	readonly retryable = true;

	constructor(domain: string) {
		super(`key lookup for "${domain}" refused: too many DNS lookups already in flight`);
		this.name = 'KeyLookupOverloadError';
	}
}

export interface DnsKeyDirectoryOptions {
	/** TXT resolver. Required — this module never imports one. */
	resolveTxt: ResolveTxt;
	/** Monotonic-enough millisecond clock; defaults to `Date.now`. */
	now?: () => number;
	ttlMs?: number;
	negativeTtlMs?: number;
	maxEntries?: number;
	/** Ceiling on simultaneous outbound lookups; defaults to {@link DEFAULT_MAX_CONCURRENT_LOOKUPS}. */
	maxConcurrentLookups?: number;
}

interface CacheEntry {
	records: readonly string[];
	expiresAt: number;
}

/**
 * DNS error codes that mean "asked and answered: nothing is published there",
 * as opposed to "we could not ask".
 */
const DEFINITIVE_MISS = new Set(['ENOTFOUND', 'ENODATA']);

function isDefinitiveMiss(error: unknown): boolean {
	if (typeof error !== 'object' || error === null || !('code' in error)) return false;
	const { code } = error as { code: unknown };
	return typeof code === 'string' && DEFINITIVE_MISS.has(code);
}

function positiveInteger(name: string, value: number): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive integer`);
	}
	return value;
}

export class DnsKeyDirectory implements KeyDirectory {
	readonly #resolveTxt: ResolveTxt;
	readonly #now: () => number;
	readonly #ttlMs: number;
	readonly #negativeTtlMs: number;
	readonly #maxEntries: number;
	readonly #maxConcurrentLookups: number;
	/** Insertion-ordered, which is what makes oldest-first eviction a `keys().next()`. */
	readonly #cache = new Map<string, CacheEntry>();
	readonly #inFlight = new Map<string, Promise<readonly string[]>>();

	constructor(options: DnsKeyDirectoryOptions) {
		this.#resolveTxt = options.resolveTxt;
		this.#now = options.now ?? Date.now;
		this.#ttlMs = positiveInteger('ttlMs', options.ttlMs ?? DEFAULT_KEY_TTL_MS);
		this.#negativeTtlMs = positiveInteger(
			'negativeTtlMs',
			options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS
		);
		this.#maxEntries = positiveInteger(
			'maxEntries',
			options.maxEntries ?? DEFAULT_MAX_CACHED_DOMAINS
		);
		this.#maxConcurrentLookups = positiveInteger(
			'maxConcurrentLookups',
			options.maxConcurrentLookups ?? DEFAULT_MAX_CONCURRENT_LOOKUPS
		);
	}

	/**
	 * Every usable key `_ostr.<observerDomain>` publishes right now, in the
	 * order the nameserver returned them.
	 *
	 * A name that is not a domain answers empty without a query: an observer
	 * field that failed validation must not become traffic.
	 *
	 * Throws {@link KeyLookupOverloadError} when a NEW name would exceed the
	 * concurrency cap. Cache hits and joins onto an in-flight query are never
	 * refused, so saturation degrades the unseen-observer path only.
	 */
	async verifyingKeys(observerDomain: string): Promise<string[]> {
		const domain = normalizeObserverDomain(observerDomain);
		if (domain === null) return [];

		const cached = this.#cache.get(domain);
		if (cached !== undefined && cached.expiresAt > this.#now()) return [...cached.records];

		const pending = this.#inFlight.get(domain);
		if (pending !== undefined) return [...(await pending)];

		if (this.#inFlight.size >= this.#maxConcurrentLookups) throw new KeyLookupOverloadError(domain);

		const lookup = this.#lookup(domain).finally(() => {
			this.#inFlight.delete(domain);
		});
		this.#inFlight.set(domain, lookup);
		return [...(await lookup)];
	}

	/** Drop everything cached — for an operator signal, and for tests. */
	clear(): void {
		this.#cache.clear();
	}

	async #lookup(domain: string): Promise<readonly string[]> {
		let answers: string[][];
		try {
			answers = await this.#resolveTxt(ostrKeyRecordName(domain));
		} catch (error) {
			if (!isDefinitiveMiss(error)) throw error;
			answers = [];
		}
		const records = collectRecords(answers);
		this.#remember(domain, records);
		return records;
	}

	#remember(domain: string, records: readonly string[]): void {
		const ttl = records.length > 0 ? this.#ttlMs : this.#negativeTtlMs;
		// Delete first so a refreshed entry moves to the young end of the map
		// rather than keeping the insertion position it had on the first miss.
		this.#cache.delete(domain);
		while (this.#cache.size >= this.#maxEntries) {
			const oldest = this.#cache.keys().next();
			if (oldest.done === true) break;
			this.#cache.delete(oldest.value);
		}
		this.#cache.set(domain, { records, expiresAt: this.#now() + ttl });
	}
}

/**
 * The usable records out of one TXT answer set.
 *
 * A TXT RRset is a set of records, each a sequence of character-strings that a
 * resolver hands over already split; joining them without a separator is what
 * RFC 1035 says the value is, and it is how a >255-byte record survives
 * provisioning. Records that do not parse are dropped rather than fatal: a name
 * legitimately carries several during rotation, plus whatever else an operator
 * has put there, and one broken sibling must not disable the good key.
 *
 * WHAT IS KEPT IS WHAT WAS PUBLISHED. A record that parses is cached verbatim,
 * not re-rendered from its public key: re-rendering would discard every tag the
 * domain also published, and the first `v=1` tag that carries meaning — a
 * validity window, a strictness flag — would then be silently dropped and this
 * node would verify against a more permissive record than DNS states. Two
 * records naming the same key still collapse to the first spelling, which keeps
 * the working set bounded by keys rather than by formatting.
 */
function collectRecords(answers: readonly string[][]): readonly string[] {
	const byKey = new Map<string, string>();
	for (const chunks of answers) {
		const text = chunks.join('');
		const parsed = parseOstrKeyRecord(text);
		if (!parsed.ok) continue;
		if (!byKey.has(parsed.publicKeyBase64)) byKey.set(parsed.publicKeyBase64, text);
	}
	return [...byKey.values()];
}
