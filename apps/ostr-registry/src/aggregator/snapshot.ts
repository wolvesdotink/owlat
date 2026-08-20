/**
 * Snapshot assembly and the diff between refreshes (plan §8.3, spec 08 §8.3).
 *
 * Both are pure functions of the materialized rows, which is what makes the
 * published artifacts reproducible: entries are ordered by subject key, the
 * declared head set is the log's own signed head, and ed25519 over the RFC 8785
 * canonical form is deterministic — so the same log prefix scored at the same
 * `asOf` produces the same snapshot bytes, signature included, on any
 * aggregator holding the same key.
 */

import { signSnapshot } from '@owlat/ostr-core';
import type { SignedTreeHead, SnapshotEntry, SnapshotFile, Tier } from '@owlat/ostr-core';
import type { MaterializedRow } from './store.js';

/** Snapshot entries in subject-key order. */
export function snapshotEntries(rows: readonly MaterializedRow[]): SnapshotEntry[] {
	return [...rows]
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
		.map((row) => ({ subject: row.subject, tier: row.tier, score: row.score }));
}

export interface SnapshotInput {
	policy: string;
	asOf: string;
	/** The as-of head set: the log heads the scores were computed against. */
	heads: readonly SignedTreeHead[];
	rows: readonly MaterializedRow[];
}

export function buildSnapshot(input: SnapshotInput, privateKeyBase64: string): SnapshotFile {
	return signSnapshot(
		{
			v: 1,
			policy: input.policy,
			asOf: input.asOf,
			heads: [...input.heads],
			entries: snapshotEntries(input.rows),
		},
		privateKeyBase64
	);
}

/** One diff line, carrying the subject key of the row it came from. */
export interface ChangedSubject {
	/** The row's own storage key — never re-derived, so the feed cannot desynchronize from `scores`. */
	key: string;
	entry: SnapshotEntry;
}

/**
 * The diff lines this refresh appends: subjects that are new, or whose tier or
 * score moved. A refresh that changes nothing appends nothing — the feed is an
 * incremental sync channel, not a heartbeat, and a consumer that has seen `seq`
 * is up to date until a score actually moves.
 *
 * A subject that disappears from the scored set appends nothing either: the
 * feed's entry shape has no tombstone, so a consumer learns about removals from
 * the next snapshot. Stated here because it is a real gap in incremental sync,
 * not an oversight — a tombstone needs a wire format `@owlat/ostr-core` does
 * not define.
 */
export function changedEntries(
	previous: ReadonlyMap<string, { tier: Tier; score: number }>,
	rows: readonly MaterializedRow[]
): ChangedSubject[] {
	const changed: ChangedSubject[] = [];
	for (const row of [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
		const before = previous.get(row.key);
		if (before !== undefined && before.tier === row.tier && before.score === row.score) continue;
		changed.push({
			key: row.key,
			entry: { subject: row.subject, tier: row.tier, score: row.score },
		});
	}
	return changed;
}
