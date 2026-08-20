import {
	canonicalBytes,
	parseHash,
	verifyConsistency,
	verifyInclusion,
	verifyTreeHead,
	type SequencedAttestation,
	type SignedTreeHead,
} from '@owlat/ostr-core';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { FakeScoreIndex } from './fakes.js';
import { makeLog, makeObserver, trafficSummary } from './fixtures.js';

const NOW = '2026-08-20T12:00:00.000Z';
const observer = makeObserver();

/** A published hex digest as raw bytes; a malformed one fails the test loudly. */
function hash(hex: string): Buffer {
	const parsed = parseHash(hex);
	if (parsed === undefined) throw new Error(`not a lowercase sha256 hex digest: ${hex}`);
	return parsed;
}

async function setup(entries: number) {
	const { log, logPublicKey } = makeLog([observer]);
	const leafHashes: string[] = [];
	for (let i = 0; i < entries; i++) {
		const outcome = await log.submit(
			trafficSummary(observer, { domain: `sender${i}.example` }),
			NOW
		);
		expect(outcome.accepted).toBe(true);
		if (outcome.accepted) leafHashes.push(outcome.promise.leafHash);
	}
	// The composition root wires the same seam over its store; the fake's is the
	// dedupe index it already keeps.
	const app = createApp(
		{ log, scores: new FakeScoreIndex() },
		{ now: () => NOW, leafIndex: (hex) => log.indexOfLeafHash(hex) }
	);
	return { app, log, logPublicKey, leafHashes };
}

describe('GET /v1/log/sth', () => {
	it('answers 404 before the first publication', async () => {
		const { app } = await setup(2);

		const res = await app.request('/v1/log/sth');

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'no tree head published yet' });
	});

	it('serves a head a verifier accepts', async () => {
		const { app, log, logPublicKey } = await setup(3);
		await log.publishHead(NOW);

		const res = await app.request('/v1/log/sth');

		expect(res.status).toBe(200);
		const head = (await res.json()) as SignedTreeHead;
		expect(head.treeSize).toBe(3);
		expect(verifyTreeHead(head, logPublicKey)).toBe(true);
	});

	it('is never cached: a stale head hides a stalled log', async () => {
		const { app, log } = await setup(1);
		await log.publishHead(NOW);

		const res = await app.request('/v1/log/sth');

		expect(res.headers.get('cache-control')).toBe('no-store');
	});
});

describe('GET /v1/log/proof/inclusion', () => {
	it('serves a path that verifies against the published head', async () => {
		const { app, log, logPublicKey } = await setup(5);
		const head = await log.publishHead(NOW);
		expect(verifyTreeHead(head, logPublicKey)).toBe(true);

		// Exactly what a monitor does: take the entry and the path from the API,
		// the root from the signed head, and check them without trusting either.
		const entryRes = await app.request('/v1/log/entries?start=3&end=3');
		const [entry] = (await entryRes.json()) as SequencedAttestation[];
		const res = await app.request('/v1/log/proof/inclusion?index=3&size=5');

		expect(res.status).toBe(200);
		const proof = (await res.json()) as string[];
		if (entry === undefined) throw new Error('the API served no entry at index 3');
		expect(
			verifyInclusion({
				leaf: canonicalBytes(entry.attestation),
				index: 3,
				treeSize: 5,
				proof: proof.map(hash),
				root: hash(head.rootHash),
			})
		).toBe(true);
	});

	it('serves the same path for the leaf hash the inclusion promise carries', async () => {
		const { app, leafHashes } = await setup(5);
		const leaf = leafHashes[3];
		if (leaf === undefined) throw new Error('the log returned no promise for the fourth leaf');

		// The submitter's flow: hold the signed promise, ask for a proof. The
		// promise carries `leafHash` and no index at all (spec 05 §5.2).
		const byHash = await app.request(`/v1/log/proof/inclusion?hash=${leaf}&size=5`);
		const byIndex = await app.request('/v1/log/proof/inclusion?index=3&size=5');

		expect(byHash.status).toBe(200);
		expect(await byHash.json()).toEqual(await byIndex.json());
	});

	it('answers 404 for a leaf hash this log does not hold', async () => {
		const { app } = await setup(2);

		const res = await app.request(`/v1/log/proof/inclusion?hash=${'ab'.repeat(32)}&size=2`);

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'no leaf with that hash' });
	});

	it('answers 501 for the hash form when no lookup is wired', async () => {
		const { log, leafHashes } = await setup(2);
		const bare = createApp({ log, scores: new FakeScoreIndex() });

		const res = await bare.request(`/v1/log/proof/inclusion?hash=${leafHashes[0] ?? ''}&size=2`);

		expect(res.status).toBe(501);
		expect((await res.json()) as { error: string }).toMatchObject({
			error: expect.stringContaining('leaf hash'),
		});
	});

	it('serves an empty path for the single-leaf tree', async () => {
		const { app } = await setup(1);

		const res = await app.request('/v1/log/proof/inclusion?index=0&size=1');

		expect(await res.json()).toEqual([]);
	});

	it('lets a proof be cached forever: an append-only path cannot change', async () => {
		const { app } = await setup(1);

		const res = await app.request('/v1/log/proof/inclusion?index=0&size=1');

		expect(res.headers.get('cache-control')).toBe('public, max-age=86400, immutable');
	});

	it.each([
		['a missing index and hash', 'size=2', 'index is required'],
		['a missing size', 'index=0', 'size is required'],
		['a fractional index', 'index=1.5&size=2', 'index must be a non-negative integer'],
		['a negative index', 'index=-1&size=2', 'index must be a non-negative integer'],
		['index at size', 'index=2&size=2', 'index must be less than size'],
		['index past size', 'index=9&size=2', 'index must be less than size'],
		['a repeated size', 'index=0&size=1&size=2', 'size must be given at most once'],
		[
			'an uppercase hash',
			`hash=${'AB'.repeat(32)}&size=2`,
			'hash must be a lowercase sha256 digest in hex',
		],
		['a truncated hash', 'hash=abcd&size=2', 'hash must be a lowercase sha256 digest in hex'],
		[
			'both a hash and an index',
			`hash=${'ab'.repeat(32)}&index=0&size=2`,
			'hash and index must not both be given',
		],
	])('answers 400 for %s', async (_label, query, message) => {
		const { app } = await setup(2);

		const res = await app.request(`/v1/log/proof/inclusion?${query}`);

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: message });
	});

	it('rejects a size beyond the tree before asking the log', async () => {
		const { app } = await setup(2);

		const res = await app.request('/v1/log/proof/inclusion?index=0&size=99');

		expect(res.status).toBe(400);
		expect((await res.json()) as { error: string }).toMatchObject({
			error: expect.stringContaining('tree size'),
		});
	});
});

describe('GET /v1/log/proof/consistency', () => {
	it('serves a proof that verifies between two published heads', async () => {
		const { app, log } = await setup(3);
		const oldHead = await log.publishHead(NOW);
		await log.submit(trafficSummary(observer, { domain: 'later.example' }), NOW);
		const newHead = await log.publishHead('2026-08-20T13:00:00.000Z');

		const res = await app.request('/v1/log/proof/consistency?from=3&to=4');

		expect(res.status).toBe(200);
		const proof = (await res.json()) as string[];
		expect(
			verifyConsistency({
				oldSize: 3,
				newSize: 4,
				oldRoot: hash(oldHead.rootHash),
				newRoot: hash(newHead.rootHash),
				proof: proof.map(hash),
			})
		).toBe(true);
	});

	it('still accepts the deprecated old/new spelling', async () => {
		const { app } = await setup(4);

		const spec = await app.request('/v1/log/proof/consistency?from=2&to=4');
		const legacy = await app.request('/v1/log/proof/consistency?old=2&new=4');

		expect(legacy.status).toBe(200);
		expect(await legacy.json()).toEqual(await spec.json());
	});

	it('serves an empty proof for equal sizes', async () => {
		const { app } = await setup(2);

		const res = await app.request('/v1/log/proof/consistency?from=2&to=2');

		expect(await res.json()).toEqual([]);
	});

	it.each([
		['from above to', 'from=3&to=1', 'from must not exceed to'],
		['a missing to', 'from=1', 'to is required'],
		['a missing from', 'to=1', 'from is required'],
		['a signed from', 'from=%2B1&to=2', 'from must be a non-negative integer'],
		['a signed old', 'old=%2B1&to=2', 'old must be a non-negative integer'],
		['both from and old', 'from=1&old=1&to=2', 'from and old must not both be given'],
		['both to and new', 'from=1&to=2&new=2', 'to and new must not both be given'],
	])('answers 400 for %s', async (_label, query, message) => {
		const { app } = await setup(3);

		const res = await app.request(`/v1/log/proof/consistency?${query}`);

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: message });
	});

	it('rejects a to beyond the tree before asking the log', async () => {
		const { app } = await setup(2);

		const res = await app.request('/v1/log/proof/consistency?from=1&to=50');

		expect(res.status).toBe(400);
		expect((await res.json()) as { error: string }).toMatchObject({
			error: expect.stringContaining('tree size'),
		});
	});
});

describe('GET /v1/log/entries', () => {
	it('serves an inclusive range', async () => {
		const { app } = await setup(5);

		const res = await app.request('/v1/log/entries?start=1&end=2');

		expect(res.status).toBe(200);
		const entries = (await res.json()) as SequencedAttestation[];
		expect(entries.map((entry) => entry.index)).toEqual([1, 2]);
	});

	it('truncates an over-wide range to one page', async () => {
		const { app } = await setup(3);

		const res = await app.request('/v1/log/entries?start=0&end=100000');

		expect((await res.json()) as SequencedAttestation[]).toHaveLength(3);
	});

	it('defaults end to a full page from start', async () => {
		const { app } = await setup(3);

		const res = await app.request('/v1/log/entries?start=0');

		expect((await res.json()) as SequencedAttestation[]).toHaveLength(3);
	});

	it('answers an empty page at the tail, which is what a monitor asks for', async () => {
		const { app } = await setup(3);

		const res = await app.request('/v1/log/entries?start=3');

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	it('answers 400 for a start beyond the tree', async () => {
		const { app } = await setup(3);

		const res = await app.request('/v1/log/entries?start=4');

		expect(res.status).toBe(400);
		expect((await res.json()) as { error: string }).toMatchObject({
			error: expect.stringContaining('tree size'),
		});
	});

	it.each([
		['a missing start', 'end=2', 'start is required'],
		['end below start', 'start=3&end=1', 'end must not be less than start'],
	])('answers 400 for %s', async (_label, query, message) => {
		const { app } = await setup(4);

		const res = await app.request(`/v1/log/entries?${query}`);

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: message });
	});
});
