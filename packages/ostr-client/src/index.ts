/**
 * @owlat/ostr-client — the OSTR consumer library.
 *
 * Four surfaces, in the order a receiver should prefer them:
 *
 *  1. {@link OstrClient} — the facade. Cache, then the local signed snapshot,
 *     then DNS. That order is the lookup-privacy rule of plan §8.3: a DNS
 *     query publishes who is sending you mail, and the snapshot answers the
 *     same question without telling anyone.
 *  2. {@link SnapshotStore} + {@link syncSnapshot} / {@link syncDiff} — the
 *     local scored set, verified against the aggregator's ed25519 key before
 *     it is ever used, persisted through an adapter the caller provides. The
 *     v1 diff feed is unsigned, so it is refused unless the consumer opts in
 *     (`allowUnsignedDiffs`) and answers it produces are marked as such.
 *  3. {@link lookupTierViaDns} and {@link rblLookup} — the MTA-native path
 *     (spec 08 §8.1) and the `bl.`/`wl.` A-record compatibility views.
 *  4. {@link rescoreWithLocalPolicy} — consumer sovereignty (§3, spec 08
 *     §8.4): drop an observer you do not believe and recompute locally.
 *
 * ## Why the snapshot comes first (spec 08 §8.3 — "Documentation MUST say why")
 *
 * A DNS lookup tells the resolver, and everyone on the path to it, who is
 * sending you mail; over a working day those queries are a readable map of a
 * receiver's correspondents. The signed snapshot answers the same question
 * from a file the consumer already holds, and it leaks nothing. That is why
 * the order is fixed and not a tunable — an operator who switches it for a few
 * milliseconds has handed over the map. This rationale belongs in the
 * package README as well as here, so that an operator reading the docs rather
 * than the source meets it too; see the report note handing that to the docs
 * owner.
 *
 * The package is pure. Clocks, resolvers, HTTP and storage are constructor and
 * function arguments; nothing here calls `Date.now()`, opens a socket, or
 * reads a file.
 */

export {
	DEFAULT_CACHE_TTL_SECONDS,
	OstrClient,
	tierOf,
	type AggregatorOptions,
	type OstrClientOptions,
	type TierAnswer,
	type TierOptions,
	type TierResult,
	type TierSource,
} from './client.js';

export {
	joinTxtChunks,
	lookupTierViaDns,
	tierQueryName,
	type DnsTierLookupInput,
	type DnsTierLookupResult,
	type ResolveTxt,
	type TxtRecordSet,
} from './dns.js';

export {
	isLoopbackAnswer,
	rblLookup,
	rblQueryName,
	type ResolveA,
	type RblLookupInput,
	type RblLookupResult,
	type RblView,
} from './rbl.js';

export {
	createMemoryPersistence,
	DEFAULT_MAX_DIFF_ENTRIES,
	SnapshotStore,
	type AdoptResult,
	type HydrateResult,
	type SnapshotLookup,
	type SnapshotPersistence,
	type SnapshotStoreOptions,
} from './store.js';

export {
	diffPath,
	SNAPSHOT_PATH,
	syncDiff,
	syncSnapshot,
	type FetchJson,
	type SyncDiffInput,
	type SyncDiffResult,
	type SyncSnapshotInput,
	type SyncSnapshotResult,
} from './sync.js';

export {
	filterExcludedObservers,
	isObserverExcluded,
	rescoreWithLocalPolicy,
	type ConsumerPolicy,
	type LocalScoreResult,
	type RescoreInput,
} from './rescore.js';

export {
	canonicalIp,
	normalizeDomainName,
	observerMatches,
	subjectKey,
	subjectLookupKeys,
	type CanonicalIp,
} from './subject.js';

export {
	isDiffFeedEntry,
	isSnapshotEntry,
	isSnapshotFile,
	isTier,
	parseDiffFeed,
	parsePersistedSnapshot,
	type PersistedSnapshot,
} from './parse.js';

export { DEFAULT_MAX_CACHE_ENTRIES, TtlCache, type TtlCacheOptions } from './cache.js';

/** Wire types a caller of this package needs in its own signatures. */
export type {
	DiffFeedEntry,
	DnsTierAnswer,
	SnapshotEntry,
	SnapshotFile,
	SubjectRef,
	Tier,
} from '@owlat/ostr-core';
