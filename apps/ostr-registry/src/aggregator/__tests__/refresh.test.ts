/**
 * Refresh, materialization, evidence paging, snapshots and the diff feed.
 *
 * The determinism assertion is the load-bearing one: two refreshes of the same
 * log prefix at the same `asOf` must produce byte-identical snapshots,
 * signature included. Ed25519 is deterministic and the signing input is RFC
 * 8785 canonical, so "minus signature randomness" is not a caveat this
 * implementation needs — if the bytes ever differ, the aggregator has stopped
 * being reproducible and consumers can no longer cross-check it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalize, generateEd25519KeyPair, verifySnapshotSignature } from '@owlat/ostr-core';
import { scoreSubject } from '@owlat/ostr-core/scoring';
import type { SubjectRef, Tier } from '@owlat/ostr-core';
import { MaterializedScoreIndex } from '../scoreIndex.js';
import { FakeLog } from './fakeLog.js';
import { AS_OF, corpus, declaredRangePosture, newcomerEntries } from './fixtures.js';

const ZONE = { origin: 'ostr.example', refBaseUrl: 'https://ostr.example/s' };

let dir: string;
let log: FakeLog;
let index: MaterializedScoreIndex;
let aggregatorKeys: { publicKey: string; privateKey: string };

function open(): MaterializedScoreIndex {
	return new MaterializedScoreIndex({
		dbPath: join(dir, 'aggregator.db'),
		log,
		aggregatorPrivateKeyBase64: aggregatorKeys.privateKey,
		zone: ZONE,
	});
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), 'ostr-aggregator-'));
	aggregatorKeys = generateEd25519KeyPair();
	log = new FakeLog(generateEd25519KeyPair().privateKey);
	log.append(corpus());
	await log.publishHead(AS_OF);
	index = open();
});

afterEach(() => {
	index.close();
	rmSync(dir, { recursive: true, force: true });
});

async function tierOf(subject: SubjectRef): Promise<Tier | null> {
	return (await index.score(subject))?.tier ?? null;
}

describe('refresh', () => {
	it('materializes the tier the open policy computes for every discovered subject', async () => {
		const summary = await index.refresh(AS_OF);

		expect(summary).toEqual({ subjects: 4, asOf: AS_OF });
		expect(await tierOf({ domain: 'veteran.example' })).toBe('trusted');
		expect(await tierOf({ domain: 'abusive.example' })).toBe('flagged');
		expect(await tierOf({ ip: '198.51.100.7' })).toBe('flagged');
		expect(await tierOf({ domain: 'tenant.example' })).toBe('establishing');
	});

	it('scores (ip, domain) evidence as its domain, with no separate pair identity', async () => {
		await index.refresh(AS_OF);

		// The pair is not a scored identity: the policy's evidence selection
		// ignores `ip` whenever `domain` is set, so a pair row would be a
		// byte-identical alias of the domain row.
		expect(await index.score({ domain: 'tenant.example', ip: '203.0.113.9' })).toBeNull();
		expect(await tierOf({ domain: 'tenant.example' })).toBe('establishing');
		// The tenant's evidence presented a domain, so under D2 it stays on the
		// domain; the shared IP itself is not a subject here.
		expect(await index.score({ ip: '203.0.113.9' })).toBeNull();
	});

	it('would score a pair identically to its domain — which is why it is not materialized', async () => {
		const entries = await log.entries(0, 1000);
		const pair = scoreSubject({
			entries,
			subject: { domain: 'tenant.example', ip: '203.0.113.9' },
			asOf: AS_OF,
		});
		const bare = scoreSubject({ entries, subject: { domain: 'tenant.example' }, asOf: AS_OF });
		const unrelated = scoreSubject({
			entries,
			subject: { domain: 'tenant.example', ip: '198.51.100.200' },
			asOf: AS_OF,
		});

		expect(pair.tier).toBe(bare.tier);
		expect(pair.score).toBe(bare.score);
		expect(pair.explanation).toEqual(bare.explanation);
		// Even an address that never appeared in the log: the pair carries no
		// information the domain does not.
		expect(unrelated.score).toBe(bare.score);
	});

	it('keys subjects by the policy identity, not by the spelling the caller used', async () => {
		await index.refresh(AS_OF);

		const scored = await index.score({ domain: 'VETERAN.Example.' });
		expect(scored?.subject).toEqual({ domain: 'veteran.example' });
		expect((await index.score({ ip: '198.51.100.7' }))?.score).toBe(0);
		// Leading zeros are octal to some resolvers and decimal to others, so
		// the policy refuses the spelling outright rather than guessing.
		expect(await index.score({ ip: '198.051.100.007' })).toBeNull();
	});

	it('stores the policy version and the explanation the score came with', async () => {
		await index.refresh(AS_OF);

		const scored = await index.score({ domain: 'abusive.example' });
		expect(scored?.policy).toBe('ostr-policy-v1');
		expect(scored?.explanation.map((group) => group.signal)).toContain('complaint-rate');
		for (const group of scored?.explanation ?? []) {
			expect(group.evidence.length).toBeGreaterThan(0);
		}
	});

	it('returns null for a subject nobody has attested about', async () => {
		await index.refresh(AS_OF);

		expect(await index.score({ domain: 'silent.example' })).toBeNull();
		expect(await index.score({})).toBeNull();
	});

	it('scores only what the declared head covers', async () => {
		log.append(newcomerEntries());
		// No publishHead: the new entries are not covered by the head the
		// snapshot declares, so this refresh must not see them.
		await index.refresh(AS_OF);
		expect(await index.score({ domain: 'newcomer.example' })).toBeNull();

		await log.publishHead(AS_OF);
		await index.refresh(AS_OF);
		expect(await tierOf({ domain: 'newcomer.example' })).toBe('establishing');
	});
});

describe('evidence', () => {
	it("pages the subject's attestations newest first", async () => {
		await index.refresh(AS_OF);

		const all = await index.evidence({ domain: 'veteran.example' }, 0, 100);
		expect(all.length).toBeGreaterThan(1);
		const times = all.map((entry) => entry.loggedAt);
		expect([...times].sort().reverse()).toEqual(times);
		for (const entry of all) {
			expect(entry.attestation.subject.domain).toBe('veteran.example');
		}

		const firstPage = await index.evidence({ domain: 'veteran.example' }, 0, 2);
		const secondPage = await index.evidence({ domain: 'veteran.example' }, 2, 2);
		expect(firstPage.map((entry) => entry.index)).toEqual(all.slice(0, 2).map((e) => e.index));
		expect(secondPage.map((entry) => entry.index)).toEqual(all.slice(2, 4).map((e) => e.index));
	});

	it('pages evidence that reached a subject indirectly, through a declared range', async () => {
		log.append([declaredRangePosture('roller.example', ['198.51.100.7'])]);
		await log.publishHead(AS_OF);
		await index.refresh(AS_OF);

		const evidence = await index.evidence({ domain: 'roller.example' }, 0, 50);
		// The bare-IP records never named `roller.example`; the posture pulled
		// them in, and the explanation is what says so.
		expect(evidence.some((entry) => entry.attestation.subject.ip === '198.51.100.7')).toBe(true);
		expect(await tierOf({ domain: 'roller.example' })).toBe('flagged');
	});

	it('is empty for an unknown subject', async () => {
		await index.refresh(AS_OF);

		expect(await index.evidence({ domain: 'silent.example' }, 0, 10)).toEqual([]);
	});
});

describe('snapshot', () => {
	it('is signed by the aggregator and declares the log head it was scored against', async () => {
		await index.refresh(AS_OF);

		const snapshot = await index.snapshot();
		expect(snapshot).not.toBeNull();
		expect(verifySnapshotSignature(snapshot!, aggregatorKeys.publicKey)).toBe(true);
		expect(verifySnapshotSignature(snapshot!, generateEd25519KeyPair().publicKey)).toBe(false);
		expect(snapshot?.policy).toBe('ostr-policy-v1');
		expect(snapshot?.asOf).toBe(AS_OF);
		expect(snapshot?.heads).toEqual([await log.head()]);
		expect(snapshot?.entries).toHaveLength(4);
	});

	it('is byte-identical across two refreshes of the same log prefix at the same asOf', async () => {
		await index.refresh(AS_OF);
		const first = canonicalize((await index.snapshot())!);
		await index.refresh(AS_OF);
		const second = canonicalize((await index.snapshot())!);

		expect(second).toBe(first);
	});

	it('is byte-identical for a second aggregator holding the same log and key', async () => {
		await index.refresh(AS_OF);
		const mine = canonicalize((await index.snapshot())!);

		const mirrorDir = mkdtempSync(join(tmpdir(), 'ostr-mirror-'));
		const mirror = new MaterializedScoreIndex({
			dbPath: join(mirrorDir, 'aggregator.db'),
			log,
			aggregatorPrivateKeyBase64: aggregatorKeys.privateKey,
			zone: ZONE,
		});
		await mirror.refresh(AS_OF);
		const theirs = canonicalize((await mirror.snapshot())!);
		mirror.close();
		rmSync(mirrorDir, { recursive: true, force: true });

		expect(theirs).toBe(mine);
	});

	it('is null before the first refresh', async () => {
		expect(await index.snapshot()).toBeNull();
	});
});

describe('diff feed', () => {
	it('grows only when a score actually moves', async () => {
		await index.refresh(AS_OF);
		const first = await index.diffSince(0);
		expect(first).toHaveLength(4);
		expect(first.map((line) => line.seq)).toEqual([1, 2, 3, 4]);
		expect(first.every((line) => line.asOf === AS_OF)).toBe(true);

		// Same log, same asOf: nothing moved, so nothing is appended.
		await index.refresh(AS_OF);
		expect(await index.diffSince(0)).toEqual(first);

		log.append(newcomerEntries());
		await log.publishHead(AS_OF);
		await index.refresh(AS_OF);

		const added = await index.diffSince(4);
		expect(added).toHaveLength(1);
		expect(added[0]?.entry.subject).toEqual({ domain: 'newcomer.example' });
		expect(added[0]?.seq).toBe(5);
	});

	it('survives a restart of the process on the same database', async () => {
		await index.refresh(AS_OF);
		index.close();

		index = open();
		expect(await index.diffSince(0)).toHaveLength(4);
		expect(await index.snapshot()).not.toBeNull();
		expect(await tierOf({ domain: 'veteran.example' })).toBe('trusted');
	});
});
