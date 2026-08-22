/**
 * Aggregator module: the reference implementation of {@link ScoreIndex}
 * (plan §4.1, §6.2, §8).
 *
 * `MaterializedScoreIndex` is the composed object the registry wires up; the
 * pieces underneath it — subject discovery, snapshot assembly, zone rendering —
 * are exported too, because they are pure and a monitor recomputing this
 * aggregator's output wants them without the store.
 */

export {
	DEFAULT_REFRESH_WORK_BUDGET,
	MAX_EVIDENCE_PAGE,
	MaterializedScoreIndex,
	type AggregatorLogger,
	type MaterializedScoreIndexOptions,
} from './scoreIndex.js';
export {
	buildSnapshot,
	changedEntries,
	snapshotEntries,
	type ChangedSubject,
	type SnapshotInput,
} from './snapshot.js';
export {
	canonicalSubject,
	discoverSubjects,
	isScorableSubject,
	subjectKey,
	type DiscoveredSubject,
} from './subjects.js';
export {
	DEFAULT_SOA,
	DEFAULT_TTL_SECONDS,
	renderZone,
	validateZoneConfig,
	type OnInvalidRow,
	type ResolvedZone,
	type SoaTimers,
	type ZoneConfig,
	type ZoneRow,
} from './zone.js';
export {
	DIFF_FEED_MAX_ROWS,
	MAX_DIFF_PAGE,
	ScoreStore,
	type DiffPageRow,
	type EvidenceRef,
	type MaterializedRow,
	type RefreshCommit,
	type ScoreStoreOptions,
} from './store.js';
export { StoreCorruptionError } from './hydrate.js';
