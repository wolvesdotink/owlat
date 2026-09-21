/**
 * The consumer facade: one lookup over the local snapshot, the DNS zone and a
 * TTL cache.
 *
 * ## Snapshot first, DNS second — and why that order is not a performance
 * choice
 *
 * A DNS lookup tells the resolver, and everyone on the path to it, who is
 * sending you mail. Over a working day those queries are a readable map of a
 * receiver's correspondents, published to parties who were never given it.
 * The signed snapshot answers the same question from a file the consumer
 * already holds, and it leaks nothing.
 *
 * So this client resolves in a fixed order — cache, local snapshot, then DNS —
 * and DNS is reached only when the snapshot has no entry for the subject
 * (plan §8.3, spec 08 §8.3 "Why the snapshot path exists"). The order is not
 * configurable and is not a tunable: an operator who swaps it for a few
 * milliseconds has handed over the map. What *is* configurable is turning the
 * fallback off entirely — `tier(subject, { allowDns: false })`, or simply
 * constructing the client without a resolver — for a deployment that would
 * rather answer "unknown" than ask anyone.
 *
 * ## "No answer" and "unknown" are one verdict
 *
 * Spec 08 §8.1: "A subject with no evidence MUST get either `tier=unknown` or
 * NXDOMAIN, and the aggregator MUST document which. Clients MUST treat both the
 * same way." {@link OstrClient.tier} returns `null` for the first shape and a
 * `tier: 'unknown'` answer for the second, and a caller MUST map them to the
 * same delivery decision — {@link tierOf} does exactly that and is the
 * supported way to ask. What is *not* the same is a lookup that failed, which
 * says nothing about the sender; {@link OstrClient.resolveTier} keeps that
 * third case visible for callers that want to distinguish it.
 *
 * Everything impure is injected: the clock (`now`), the resolver
 * (`resolveTxt`), the aggregator transport (`aggregator.fetchJson`) and the
 * snapshot's persistence adapter. The package itself opens no socket, reads no
 * file and never calls `Date.now()`.
 */

import type { SubjectRef, Tier } from '@owlat/ostr-core';
import { TtlCache } from './cache.js';
import { lookupTierViaDns, type ResolveTxt } from './dns.js';
import { SnapshotStore, type HydrateResult, type SnapshotPersistence } from './store.js';
import { subjectKey } from './subject.js';
import {
	syncDiff,
	syncSnapshot,
	type FetchJson,
	type SyncDiffResult,
	type SyncSnapshotResult,
} from './sync.js';

export interface AggregatorOptions {
	fetchJson: FetchJson;
	/** The aggregator's ed25519 public key, base64, used to verify snapshots. */
	publicKey: string;
}

export interface OstrClientOptions {
	/** Aggregator zone apex for DNS lookups, e.g. `ostr.example`. */
	zone?: string;
	aggregator?: AggregatorOptions;
	/** Omit to disable the DNS fallback entirely. */
	resolveTxt?: ResolveTxt;
	/** Supply a store the caller has already built (e.g. with a file adapter). */
	store?: SnapshotStore;
	/**
	 * Convenience: build the store from this adapter and the aggregator key.
	 * Passing it together with `store` throws — a caller's durability
	 * configuration must not disappear because another option outranked it.
	 */
	persistence?: SnapshotPersistence;
	/**
	 * Accept the unsigned diff feed (default false). Also refused alongside
	 * `store`: configure it on the store the caller built.
	 */
	allowUnsignedDiffs?: boolean;
	/** Default 3600, matching the TTL the zone publishes for hot entries. */
	cacheTtlSeconds?: number;
	maxCacheEntries?: number;
	/** Epoch seconds. Required: this package never reads the system clock. */
	now: () => number;
}

/**
 * Where an answer came from. `diff` is a snapshot entry that an unsigned
 * diff-feed line has since moved, `cache` is a repeat of an earlier answer of
 * any kind (the `verified` flag survives the repeat).
 */
export type TierSource = 'snapshot' | 'diff' | 'dns' | 'cache';

export interface TierAnswer {
	tier: Tier;
	/** 0-100. */
	score: number;
	source: TierSource;
	/** RFC 3339 instant the score was computed at. */
	asOf: string;
	/**
	 * True only when this client checked an aggregator signature over the data
	 * behind the answer — i.e. a snapshot entry in a store with a public key
	 * configured. A DNS answer is false (whatever DNSSEC validation the
	 * injected resolver performs happened outside this library), and so is an
	 * answer a diff-feed line produced, because nothing signs one.
	 */
	verified: boolean;
	/** Policy version behind the answer, when the source states one. */
	policy?: string;
	/**
	 * The oldest timestamp in the as-of head set: the instant up to which every
	 * trusted log had been accounted for (spec 08 §8.1). Absent when the source
	 * does not state one.
	 */
	headsAsOf?: string;
}

/**
 * A resolution outcome. `none` is a fact about the subject — nobody has
 * evidence — and is the same verdict as `tier: 'unknown'`. `error` is a fact
 * about the lookup and MUST NOT be read as "unknown sender".
 */
export type TierResult =
	| { status: 'answer'; answer: TierAnswer }
	| { status: 'none' }
	| { status: 'error'; errors: string[] };

export interface TierOptions {
	/** Set false to refuse the DNS fallback for this lookup (default true). */
	allowDns?: boolean;
	/** Set true to bypass a cached answer and resolve again. */
	refresh?: boolean;
}

export const DEFAULT_CACHE_TTL_SECONDS = 3600;

/**
 * The tier a delivery decision should use: the answer's own, or `unknown` when
 * there is no answer.
 *
 * This is the §8.1 rule in one function — NXDOMAIN and `tier=unknown` are one
 * verdict — so that a caller cannot implement it two different ways in two
 * places.
 */
export function tierOf(answer: TierAnswer | null): Tier {
	return answer === null ? 'unknown' : answer.tier;
}

/** Cached answers include misses: a repeated miss must not re-query DNS. */
interface CachedAnswer {
	answer: TierAnswer | null;
}

export class OstrClient {
	private readonly zone: string | null;
	private readonly aggregator: AggregatorOptions | null;
	private readonly resolveTxt: ResolveTxt | null;
	private readonly store: SnapshotStore;
	private readonly cache: TtlCache<CachedAnswer>;
	/** Shared in-flight DNS lookups, keyed by subject. */
	private readonly inFlight = new Map<string, Promise<TierResult>>();
	private storeRevision: number;

	constructor(options: OstrClientOptions) {
		if (options.store !== undefined) {
			if (options.persistence !== undefined) {
				throw new Error('OstrClient: pass either `store` or `persistence`, not both');
			}
			if (options.allowUnsignedDiffs !== undefined) {
				throw new Error('OstrClient: configure `allowUnsignedDiffs` on the store you supplied');
			}
		}
		this.zone = options.zone ?? null;
		this.aggregator = options.aggregator ?? null;
		this.resolveTxt = options.resolveTxt ?? null;
		this.store =
			options.store ??
			new SnapshotStore({
				...(options.persistence === undefined ? {} : { persistence: options.persistence }),
				...(options.aggregator === undefined ? {} : { publicKey: options.aggregator.publicKey }),
				...(options.allowUnsignedDiffs === undefined
					? {}
					: { allowUnsignedDiffs: options.allowUnsignedDiffs }),
			});
		this.storeRevision = this.store.revision();
		this.cache = new TtlCache<CachedAnswer>({
			now: options.now,
			ttlSeconds: options.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS,
			...(options.maxCacheEntries === undefined ? {} : { maxEntries: options.maxCacheEntries }),
		});
	}

	/** The local scored set, for callers that want the store directly. */
	snapshotStore(): SnapshotStore {
		return this.store;
	}

	/**
	 * Resolve a subject's tier: cache, then the local snapshot, then DNS.
	 *
	 * `null` covers both "nobody has an answer" and "the lookup failed", which
	 * are not the same thing — see {@link resolveTier} for a caller that needs
	 * to tell them apart, and {@link tierOf} for one that does not.
	 */
	async tier(subject: SubjectRef, options: TierOptions = {}): Promise<TierAnswer | null> {
		const result = await this.resolveTier(subject, options);
		return result.status === 'answer' ? result.answer : null;
	}

	/**
	 * As {@link tier}, keeping the three outcomes apart: an answer, a subject
	 * nobody has evidence about, and a lookup that could not be completed.
	 */
	async resolveTier(subject: SubjectRef, options: TierOptions = {}): Promise<TierResult> {
		const key = subjectKey(subject);
		if (key === null) {
			return { status: 'error', errors: ['subject names neither a domain nor a queryable IP'] };
		}
		this.dropCacheOnStoreChange();

		if (options.refresh !== true) {
			const cached = this.cache.get(key);
			if (cached !== null) {
				return cached.answer === null
					? { status: 'none' }
					: { status: 'answer', answer: { ...cached.answer, source: 'cache' } };
			}
		}

		const local = this.localAnswer(subject);
		if (local !== null) {
			this.cache.set(key, { answer: local });
			return { status: 'answer', answer: local };
		}

		if (options.allowDns === false || this.resolveTxt === null || this.zone === null) {
			return { status: 'none' };
		}
		return this.viaDns(key, subject);
	}

	/** Load the persisted snapshot, if the store was given a persistence adapter. */
	async hydrate(): Promise<HydrateResult> {
		const result = await this.store.hydrate();
		if (result.status === 'loaded') this.cache.clear();
		this.storeRevision = this.store.revision();
		return result;
	}

	/** Fetch, verify and adopt the aggregator's current snapshot. */
	async syncSnapshot(): Promise<SyncSnapshotResult> {
		if (this.aggregator === null) return { ok: false, errors: ['no aggregator configured'] };
		const result = await syncSnapshot({
			fetchJson: this.aggregator.fetchJson,
			aggregatorPublicKeyBase64: this.aggregator.publicKey,
			store: this.store,
		});
		if (result.ok) this.cache.clear();
		this.storeRevision = this.store.revision();
		return result;
	}

	/**
	 * Apply the diff feed since the last applied sequence. Refused unless the
	 * store accepts unsigned diffs — see
	 * {@link SnapshotStoreOptions.allowUnsignedDiffs}.
	 *
	 * A caller that keeps a long-lived cursor checks `gapDetected` on the
	 * result: the feed is pruned, and the answer to a cursor that has fallen off
	 * the end is {@link syncSnapshot}, not another page.
	 */
	async syncDiff(): Promise<SyncDiffResult> {
		if (this.aggregator === null) return { ok: false, errors: ['no aggregator configured'] };
		const result = await syncDiff({ fetchJson: this.aggregator.fetchJson, store: this.store });
		if (result.ok && result.applied > 0) this.cache.clear();
		this.storeRevision = this.store.revision();
		return result;
	}

	/**
	 * The store is handed out by {@link snapshotStore}, so a caller can adopt a
	 * snapshot or apply diffs without going through this class. Comparing the
	 * store's revision before serving a cached answer is what stops those
	 * writes from being invisible until a TTL runs out.
	 */
	private dropCacheOnStoreChange(): void {
		const revision = this.store.revision();
		if (revision === this.storeRevision) return;
		this.storeRevision = revision;
		this.cache.clear();
	}

	private localAnswer(subject: SubjectRef): TierAnswer | null {
		const local = this.store.lookup(subject);
		if (local === null) return null;
		const answer: TierAnswer = {
			tier: local.entry.tier,
			score: local.entry.score,
			source: local.seq === null ? 'snapshot' : 'diff',
			asOf: local.asOf,
			verified: local.seq === null && this.store.verifiesSnapshots(),
		};
		const policy = this.store.policy();
		if (policy !== null) answer.policy = policy;
		const headsAsOf = this.store.headsAsOf();
		if (headsAsOf !== null) answer.headsAsOf = headsAsOf;
		return answer;
	}

	/**
	 * One query per subject at a time. An MTA taking a burst of connections
	 * from one sender would otherwise issue one identical lookup per
	 * connection, multiplying both the query cost and the very leak the
	 * snapshot path exists to avoid.
	 */
	private async viaDns(key: string, subject: SubjectRef): Promise<TierResult> {
		const shared = this.inFlight.get(key);
		if (shared !== undefined) return shared;
		const pending = this.lookupViaDns(key, subject).finally(() => {
			this.inFlight.delete(key);
		});
		this.inFlight.set(key, pending);
		return pending;
	}

	private async lookupViaDns(key: string, subject: SubjectRef): Promise<TierResult> {
		const zone = this.zone;
		const resolveTxt = this.resolveTxt;
		if (zone === null || resolveTxt === null) return { status: 'none' };
		const result = await lookupTierViaDns({ subject, zone, resolveTxt });
		if (result.status === 'answer') {
			const answer: TierAnswer = {
				tier: result.answer.tier,
				score: result.answer.score,
				source: 'dns',
				asOf: result.answer.asof,
				verified: false,
				policy: result.answer.policy,
				headsAsOf: result.answer.asof,
			};
			// Spec 08 §8.1: "A client MUST honour TTLs and MUST NOT pin answers
			// past them." The configured TTL is a ceiling, not a replacement:
			// an aggregator publishing 300s on a fast-moving flagged subject
			// must not be overridden by an hour of cached `trusted`.
			this.cache.set(key, { answer }, result.ttlSeconds);
			return { status: 'answer', answer };
		}
		// A resolver failure is not evidence about the sender, so it is not
		// cached; NXDOMAIN is, so a stream of mail from an unscored sender does
		// not become a stream of queries about it.
		if (result.status === 'not-found') {
			this.cache.set(key, { answer: null });
			return { status: 'none' };
		}
		return { status: 'error', errors: result.errors };
	}
}
