/**
 * The materialized store, at its own level.
 *
 * Two properties the module header makes correctness requirements and nothing
 * above this layer can check: a refresh lands whole or not at all, and the
 * scored set is *replaced* rather than merged — a subject that stops being
 * scored has to leave, taking its evidence with it, or the zone keeps
 * publishing a name the log no longer supports. The rest is what happens when
 * the file on disk is not what this process wrote.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateEd25519KeyPair, signSnapshot } from '@owlat/ostr-core';
import { signTreeHead } from '@owlat/ostr-core/merkle';
import type { SignedTreeHead, SnapshotFile } from '@owlat/ostr-core';
import { ScoreStore, type MaterializedRow, type RefreshCommit } from '../store.js';
import { StoreCorruptionError } from '../hydrate.js';

const AS_OF = '2026-08-20T00:00:00Z';
const KEY = generateEd25519KeyPair().privateKey;
const ROOT = 'a'.repeat(64);

let dir: string;
let path: string;
let store: ScoreStore;

function head(timestamp: string, treeSize = 3): SignedTreeHead {
	return signTreeHead({ logId: 'https://log.test/ostr', treeSize, rootHash: ROOT, timestamp }, KEY);
}

function row(domain: string, over: Partial<MaterializedRow> = {}): MaterializedRow {
	return {
		key: `{"domain":"${domain}"}`,
		subject: { domain },
		tier: 'establishing',
		score: 55,
		policy: 'ostr-policy-v1',
		explanation: [
			{ signal: 'history-volume', contribution: 15, summary: 'steady volume', evidence: [] },
		],
		asOf: AS_OF,
		...over,
	};
}

function snapshotOf(rows: readonly MaterializedRow[], asOf: string): SnapshotFile {
	return signSnapshot(
		{
			v: 1,
			policy: 'ostr-policy-v1',
			asOf,
			heads: [head(asOf)],
			entries: rows.map((r) => ({ subject: r.subject, tier: r.tier, score: r.score })),
		},
		KEY
	);
}

function commit(
	rows: readonly MaterializedRow[],
	over: Partial<RefreshCommit> = {}
): RefreshCommit {
	return {
		asOf: AS_OF,
		headAsOf: AS_OF,
		heads: [head(AS_OF)],
		rows,
		evidence: new Map(rows.map((r) => [r.key, [{ index: 0, loggedAt: AS_OF }]])),
		changed: rows.map((r) => ({
			key: r.key,
			entry: { subject: r.subject, tier: r.tier, score: r.score },
		})),
		snapshot: snapshotOf(rows, AS_OF),
		...over,
	};
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'ostr-store-'));
	path = join(dir, 'aggregator.db');
	store = new ScoreStore(path);
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('commitRefresh', () => {
	it('replaces the scored set wholesale, evidence included', () => {
		store.commitRefresh(commit([row('a.test'), row('b.test')]));
		store.commitRefresh(commit([row('a.test')]));

		expect(store.allScores().map((r) => r.subject)).toEqual([{ domain: 'a.test' }]);
		expect(store.score('{"domain":"b.test"}')).toBeNull();
		// The departed subject's evidence goes with it: a stale pointer would
		// answer for a subject that no longer has a score.
		expect(store.evidence('{"domain":"b.test"}', 0, 10)).toEqual([]);
	});

	it('appends to the diff feed instead of replacing it', () => {
		store.commitRefresh(commit([row('a.test')]));
		store.commitRefresh(commit([row('a.test', { tier: 'trusted', score: 90 })]));

		const feed = store.diffSince(0);
		expect(feed.map((line) => line.entry.tier)).toEqual(['establishing', 'trusted']);
		expect(feed.map((line) => line.seq)).toEqual([1, 2]);
	});

	it('keys a diff line with the row key the refresh computed', () => {
		// Not re-derived from the entry: a second derivation of the key would
		// desynchronize from `scores.subject_key` the day the format changes.
		store.commitRefresh(commit([row('a.test', { key: 'the-authoritative-key' })]));

		expect(store.diffPage(0).map((line) => line.subjectKey)).toEqual(['the-authoritative-key']);
	});

	it('carries the policy version and the as-of head set on every diff line', () => {
		// Spec 08 §8.3 wants a signed page carrying both. The envelope does not
		// exist in core yet, so the inputs to one are persisted per row.
		store.commitRefresh(commit([row('a.test')]));

		const page = store.diffPage(0);
		expect(page[0]?.policy).toBe('ostr-policy-v1');
		expect(page[0]?.heads).toEqual([head(AS_OF)]);
	});

	it('prunes the feed to its retention bound', () => {
		const bounded = new ScoreStore(join(dir, 'bounded.db'), { diffFeedMaxRows: 2 });
		for (const tier of ['establishing', 'trusted', 'warned', 'flagged'] as const) {
			bounded.commitRefresh(commit([row('a.test', { tier })]));
		}

		// The feed is history, but not unbounded history: a consumer further
		// behind than the retention window resyncs from the snapshot.
		expect(bounded.diffSince(0).map((line) => line.entry.tier)).toEqual(['warned', 'flagged']);
		bounded.close();
	});

	it('bounds a page regardless of what the caller asks for', () => {
		store.commitRefresh(commit([row('a.test')]));

		expect(store.diffPage(0, 0)).toHaveLength(1);
		expect(store.diffPage(0, 10_000_000)).toHaveLength(1);
	});

	it('rolls back a refresh that fails partway', () => {
		store.commitRefresh(commit([row('a.test')]));
		const poisoned = commit([row('b.test'), row('c.test', { tier: 'nonsense' as 'trusted' })]);

		expect(() => store.commitRefresh(poisoned)).toThrow();
		// Nothing of the failed refresh survives, and the previous one is intact.
		expect(store.allScores().map((r) => r.subject)).toEqual([{ domain: 'a.test' }]);
		expect(store.diffSince(0)).toHaveLength(1);
		// Including for anything caching on the revision: a rolled-back refresh
		// did not move the view, so it must not look like it did.
		expect(store.revision()).toBe(1);
	});

	it('publishes the head instant separately from the evaluation instant', () => {
		const later = '2026-08-20T06:00:00Z';
		store.commitRefresh(commit([row('a.test')], { asOf: later, headAsOf: AS_OF }));

		expect(store.latestAsOf()).toBe(later);
		expect(store.zoneAsOf()).toBe(AS_OF);
	});

	it('falls back to the evaluation instant when no head was declared', () => {
		store.commitRefresh(commit([row('a.test')], { headAsOf: null, heads: [] }));

		expect(store.zoneAsOf()).toBe(AS_OF);
	});
});

describe('reads between two refreshes', () => {
	it('parses the snapshot once per refresh and re-parses after the next', () => {
		store.commitRefresh(commit([row('a.test')]));
		const first = store.latestSnapshot();

		// Same object, so the HTTP layer can hold its serialized bytes against it.
		expect(store.latestSnapshot()).toBe(first);
		expect(store.revision()).toBe(1);

		store.commitRefresh(commit([row('a.test', { tier: 'trusted', score: 90 })]));

		expect(store.revision()).toBe(2);
		expect(store.latestSnapshot()).not.toBe(first);
		expect(store.latestSnapshot()?.entries[0]?.score).toBe(90);
	});

	it('reads the published feed without the columns only a signed page needs', () => {
		// The feed line carries seq, asOf and the entry. Policy and head set are
		// persisted for the signed page that does not exist yet, and hydrating a
		// head set per row to drop it is work an anonymous request should not buy.
		store.commitRefresh(commit([row('a.test')]));
		const db = new Database(path);
		db.prepare("UPDATE diff_feed SET heads = 'not-json'").run();
		db.close();

		expect(store.diffSince(0)).toHaveLength(1);
		expect(() => store.diffPage(0)).toThrow(StoreCorruptionError);
	});

	it('cuts a feed page in the query rather than in the caller', () => {
		store.commitRefresh(commit([row('a.test')]));
		store.commitRefresh(commit([row('a.test', { tier: 'trusted', score: 90 })]));

		expect(store.diffSince(0, 1).map((line) => line.seq)).toEqual([1]);
		expect(store.diffSince(0).map((line) => line.seq)).toEqual([1, 2]);
	});
});

describe('reading back a file this process did not write', () => {
	it('refuses a tier outside the vocabulary at the write', () => {
		const db = new Database(path);
		expect(() =>
			db
				.prepare(
					`INSERT INTO scores (subject_key, domain, ip, tier, score, policy, explanation, as_of)
					 VALUES ('k', 'a.test', NULL, 'excellent', 55, 'p', '[]', ?)`
				)
				.run(AS_OF)
		).toThrow(/CHECK constraint/);
		db.close();
	});

	it('refuses a malformed explanation at the read', () => {
		store.commitRefresh(commit([row('a.test')]));
		const db = new Database(path);
		db.prepare('UPDATE scores SET explanation = \'[{"signal": 7}]\'').run();
		db.close();

		expect(() => store.score('{"domain":"a.test"}')).toThrow(StoreCorruptionError);
		expect(() => store.allScores()).toThrow(/group.signal is not a string/);
	});

	it('refuses a snapshot document that is not one', () => {
		store.commitRefresh(commit([row('a.test')]));
		const db = new Database(path);
		db.prepare('UPDATE snapshot SET document = \'{"v":2}\'').run();
		db.close();

		expect(() => store.latestSnapshot()).toThrow(/unsupported version/);
	});

	it('rebuilds from empty when the file was written by another schema', () => {
		store.commitRefresh(commit([row('a.test')]));
		store.close();
		const db = new Database(path);
		db.pragma('user_version = 99');
		db.close();

		store = new ScoreStore(path);
		expect(store.allScores()).toEqual([]);
		expect(store.latestSnapshot()).toBeNull();
		expect(store.diffSince(0)).toEqual([]);
	});

	it('keeps everything when the schema version matches', () => {
		store.commitRefresh(commit([row('a.test')]));
		store.close();

		store = new ScoreStore(path);
		expect(store.allScores()).toHaveLength(1);
		expect(store.latestSnapshot()).not.toBeNull();
	});
});
