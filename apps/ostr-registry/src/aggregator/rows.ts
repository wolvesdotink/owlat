/**
 * The materialized view's SQL schema, and the mapping between a stored row and
 * the shape the rest of the aggregator works in.
 *
 * Split out of `./store.js` so that file is about the transaction and the
 * queries. The DDL and the row shapes belong together: a column added to one
 * without the other is exactly the drift `SCHEMA_VERSION` exists to catch, and
 * keeping them in one place makes that pairing hard to miss.
 */

import type { SubjectRef } from '@owlat/ostr-core';
import type { ExplanationGroup, Tier } from '@owlat/ostr-core';
import { hydrateExplanation, hydrateTier, TIER_SQL_LIST } from './hydrate.js';

/** One materialized score, as the rest of the aggregator sees it. */
export interface MaterializedRow {
	key: string;
	subject: SubjectRef;
	tier: Tier;
	score: number;
	policy: string;
	explanation: ExplanationGroup[];
	asOf: string;
}

/**
 * Bumped whenever the tables below change shape. The view is a pure function of
 * the log, so a mismatch is rebuilt rather than migrated — which also drops the
 * diff feed, and an operator upgrading across a schema change must treat it as
 * a full-resync event for consumers.
 */
export const SCHEMA_VERSION = 1;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS scores (
	subject_key TEXT PRIMARY KEY,
	domain TEXT,
	ip TEXT,
	tier TEXT NOT NULL CHECK (tier IN (${TIER_SQL_LIST})),
	score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
	policy TEXT NOT NULL,
	explanation TEXT NOT NULL,
	as_of TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS evidence (
	subject_key TEXT NOT NULL,
	log_index INTEGER NOT NULL,
	logged_at TEXT NOT NULL,
	PRIMARY KEY (subject_key, log_index)
) STRICT;

CREATE INDEX IF NOT EXISTS evidence_newest_first
	ON evidence (subject_key, logged_at DESC, log_index DESC);

CREATE TABLE IF NOT EXISTS diff_feed (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	as_of TEXT NOT NULL,
	subject_key TEXT NOT NULL,
	entry TEXT NOT NULL,
	policy TEXT NOT NULL,
	heads TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS snapshot (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	as_of TEXT NOT NULL,
	head_as_of TEXT NOT NULL,
	document TEXT NOT NULL
) STRICT;
`;

export const DROP_ALL = `
DROP TABLE IF EXISTS scores;
DROP TABLE IF EXISTS evidence;
DROP TABLE IF EXISTS diff_feed;
DROP TABLE IF EXISTS snapshot;
`;

export interface ScoreRowShape {
	subject_key: string;
	domain: string | null;
	ip: string | null;
	tier: string;
	score: number;
	policy: string;
	explanation: string;
	as_of: string;
}

export interface DiffRowShape {
	seq: number;
	as_of: string;
	subject_key: string;
	entry: string;
	policy: string;
	heads: string;
}

/** What the published feed line needs — no `policy`, no `heads`, nothing to hydrate twice. */
export type DiffLineShape = Pick<DiffRowShape, 'seq' | 'as_of' | 'entry'>;

function toSubject(row: ScoreRowShape): SubjectRef {
	const subject: SubjectRef = {};
	if (row.domain !== null) subject.domain = row.domain;
	if (row.ip !== null) subject.ip = row.ip;
	return subject;
}

/** A stored score row, shape-checked on the way out (see `./hydrate.js`). */
export function toRow(row: ScoreRowShape): MaterializedRow {
	return {
		key: row.subject_key,
		subject: toSubject(row),
		tier: hydrateTier(row.subject_key, row.tier),
		score: row.score,
		policy: row.policy,
		explanation: hydrateExplanation(row.subject_key, row.explanation),
		asOf: row.as_of,
	};
}
