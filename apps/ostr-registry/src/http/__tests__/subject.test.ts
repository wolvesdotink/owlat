import {
	canonicalBytes,
	parseHash,
	verifyInclusion,
	verifyTreeHead,
	type ScoreResult,
	type SequencedAttestation,
	type SignedTreeHead,
} from '@owlat/ostr-core';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { EvidencePage } from '../routes/subject.js';
import { FakeScoreIndex } from './fakes.js';
import {
	IPV4_SCORE,
	IPV6_SCORE,
	makeLog,
	makeObserver,
	SCORE,
	sequenced,
	trafficSummary,
} from './fixtures.js';

const observer = makeObserver();
const NOW = '2026-08-20T12:00:00.000Z';

/** A published hex digest as raw bytes; a malformed one fails the test loudly. */
function hash(hex: string): Buffer {
	const parsed = parseHash(hex);
	if (parsed === undefined) throw new Error(`not a lowercase sha256 hex digest: ${hex}`);
	return parsed;
}

function evidencePage(count: number): SequencedAttestation[] {
	return Array.from({ length: count }, (_, index) => sequenced(index, trafficSummary(observer)));
}

function setup(evidence: SequencedAttestation[] = []) {
	const scores = new FakeScoreIndex({
		scores: [SCORE, IPV4_SCORE, IPV6_SCORE],
		evidence: new Map([['sender.example|', evidence]]),
	});
	const { log } = makeLog([observer]);
	return { app: createApp({ log, scores }), scores, log };
}

/**
 * A log holding `count` distinct attestations about `sender.example`, an
 * aggregator whose evidence for that subject is exactly those entries, and a
 * published head covering them — the arrangement a real evidence page is served
 * from.
 */
async function setupLogged(count: number) {
	const { log, logPublicKey } = makeLog([observer]);
	for (let i = 0; i < count; i++) {
		const outcome = await log.submit(
			trafficSummary(
				observer,
				{ domain: 'sender.example' },
				{
					window: { from: `2026-08-${10 + i}T00:00:00Z`, to: `2026-08-${11 + i}T00:00:00Z` },
				}
			),
			NOW
		);
		expect(outcome.accepted).toBe(true);
	}
	const entries = await log.entries(0, count);
	const scores = new FakeScoreIndex({
		scores: [SCORE],
		evidence: new Map([['sender.example|', entries]]),
	});
	return { app: createApp({ log, scores }), log, logPublicKey };
}

describe('GET /v1/subject/:subject', () => {
	it('serves the score for a domain subject', async () => {
		const { app } = setup();

		const res = await app.request('/v1/subject/sender.example');

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(SCORE);
	});

	it('serves the score for an IPv4 subject', async () => {
		const { app } = setup();

		const res = await app.request('/v1/subject/192.0.2.7');

		expect(res.status).toBe(200);
		expect((await res.json()) as ScoreResult).toMatchObject({ subject: { ip: '192.0.2.7' } });
	});

	it('serves the score for a percent-encoded IPv6 subject', async () => {
		const { app } = setup();

		const res = await app.request(`/v1/subject/${encodeURIComponent('2001:db8::1')}`);

		expect(res.status).toBe(200);
		expect((await res.json()) as ScoreResult).toMatchObject({ subject: { ip: '2001:db8::1' } });
	});

	it('lets a cache hold an answer briefly', async () => {
		const { app } = setup();

		const res = await app.request('/v1/subject/sender.example');

		expect(res.headers.get('cache-control')).toBe('public, max-age=60');
	});

	it('answers 404 for a subject nobody has attested to', async () => {
		const { app } = setup();

		const res = await app.request('/v1/subject/nobody.example');

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'no score for that subject' });
	});

	it.each([
		['not-a-domain', 'not-a-domain'],
		['uppercase domain', 'Sender.Example'],
		['trailing dot', 'sender.example.'],
		['non-canonical IPv6', encodeURIComponent('2001:DB8::1')],
		['expanded IPv6', encodeURIComponent('2001:0db8:0000:0000:0000:0000:0000:0001')],
		['bad IPv4', '192.0.2.256'],
		['leading-space', `${encodeURIComponent(' ')}sender.example`],
		['trailing-space', `sender.example${encodeURIComponent(' ')}`],
	])('answers 400 for a %s subject', async (_label, raw) => {
		const { app } = setup();

		const res = await app.request(`/v1/subject/${raw}`);

		expect(res.status).toBe(400);
		expect((await res.json()) as { error: string }).toMatchObject({
			error: expect.stringContaining('subject must be'),
		});
	});
});

describe('GET /v1/subject/:subject/evidence', () => {
	it('serves the default page', async () => {
		const { app, scores } = setup(evidencePage(3));

		const res = await app.request('/v1/subject/sender.example/evidence');

		expect(res.status).toBe(200);
		expect(((await res.json()) as EvidencePage).entries).toHaveLength(3);
		expect(scores.evidenceCalls[0]).toMatchObject({ offset: 0, limit: 50 });
	});

	it('names the subject the page is about', async () => {
		const { app } = setup(evidencePage(1));

		const res = await app.request('/v1/subject/sender.example/evidence');

		expect((await res.json()) as EvidencePage).toMatchObject({
			subject: { domain: 'sender.example' },
		});
	});

	it('honours offset and limit', async () => {
		const { app, scores } = setup(evidencePage(10));

		const res = await app.request('/v1/subject/sender.example/evidence?offset=4&limit=2');

		const { entries } = (await res.json()) as EvidencePage;
		expect(entries).toHaveLength(2);
		expect(entries[0]?.index).toBe(4);
		expect(scores.evidenceCalls[0]).toMatchObject({ offset: 4, limit: 2 });
	});

	it('clamps limit to the page maximum', async () => {
		const { app, scores } = setup(evidencePage(2));

		await app.request('/v1/subject/sender.example/evidence?limit=5000');

		expect(scores.evidenceCalls[0]?.limit).toBe(100);
	});

	it('serves an empty page past the end of a scored subject', async () => {
		const { app } = setup(evidencePage(2));

		const res = await app.request('/v1/subject/sender.example/evidence?offset=99');

		expect(res.status).toBe(200);
		expect(((await res.json()) as EvidencePage).entries).toEqual([]);
	});

	it('answers 404, not an empty page, for a subject with no score', async () => {
		const { app } = setup(evidencePage(2));

		const res = await app.request('/v1/subject/nobody.example/evidence');

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'no score for that subject' });
	});

	it.each([
		['a fractional limit', 'limit=1.5', 'limit must be a non-negative integer'],
		['a negative offset', 'offset=-1', 'offset must be a non-negative integer'],
		['an exponent limit', 'limit=1e3', 'limit must be a non-negative integer'],
		['a hex offset', 'offset=0x10', 'offset must be a non-negative integer'],
		['a zero limit', 'limit=0', 'limit must be at least 1'],
		['an empty limit', 'limit=', 'limit must not be empty'],
		['a repeated limit', 'limit=1&limit=2', 'limit must be given at most once'],
	])('answers 400 for %s', async (_label, query, message) => {
		const { app } = setup();

		const res = await app.request(`/v1/subject/sender.example/evidence?${query}`);

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: message });
	});

	it('ignores unknown query parameters', async () => {
		const { app } = setup(evidencePage(1));

		const res = await app.request('/v1/subject/sender.example/evidence?_=cachebust');

		expect(res.status).toBe(200);
	});
});

describe('GET /v1/subject/:subject/evidence proofs (spec 08 §8.2)', () => {
	it('serves a proof per attestation that verifies against the signed head', async () => {
		const { app, log, logPublicKey } = await setupLogged(4);
		await log.publishHead(NOW);

		// Exactly what a client that refuses to trust the aggregator does: take
		// the evidence and its paths from one endpoint, the head from the other,
		// verify the head's signature, then verify every path against its root.
		const page = (await (
			await app.request('/v1/subject/sender.example/evidence')
		).json()) as EvidencePage;
		const head = (await (await app.request('/v1/log/sth')).json()) as SignedTreeHead;

		expect(verifyTreeHead(head, logPublicKey)).toBe(true);
		expect(page.head).toEqual(head);
		expect(page.entries).toHaveLength(4);
		for (const entry of page.entries) {
			expect(entry.proof).toBeDefined();
			expect(
				verifyInclusion({
					leaf: canonicalBytes(entry.attestation),
					index: entry.index,
					treeSize: head.treeSize,
					proof: (entry.proof ?? []).map(hash),
					root: hash(head.rootHash),
				})
			).toBe(true);
		}
	});

	it('omits the proof for an entry no published head covers yet', async () => {
		const { log } = await setupLogged(3);
		await log.publishHead(NOW);
		// A fourth entry arrives after the head; it is in the tree but not in the
		// head, so there is nothing to prove it against yet.
		await log.submit(trafficSummary(observer, { domain: 'sender.example' }), NOW);
		const scored = await log.entries(0, 4);
		const app = createApp({
			log,
			scores: new FakeScoreIndex({
				scores: [SCORE],
				evidence: new Map([['sender.example|', scored]]),
			}),
		});

		const page = (await (
			await app.request('/v1/subject/sender.example/evidence')
		).json()) as EvidencePage;

		expect(page.entries.slice(0, 3).every((entry) => entry.proof !== undefined)).toBe(true);
		expect(page.entries[3]?.proof).toBeUndefined();
	});

	it('serves a null head and no proofs before the log has published one', async () => {
		const { app } = await setupLogged(2);

		const page = (await (
			await app.request('/v1/subject/sender.example/evidence')
		).json()) as EvidencePage;

		expect(page.head).toBeNull();
		expect(page.entries.every((entry) => entry.proof === undefined)).toBe(true);
	});

	it('omits the proof for an entry sequenced in another log', async () => {
		const { log } = makeLog([observer]);
		await log.submit(trafficSummary(observer, { domain: 'sender.example' }), NOW);
		await log.publishHead(NOW);
		const foreign: SequencedAttestation = {
			...sequenced(0, trafficSummary(observer)),
			logId: 'https://other-log.test/ostr',
		};
		const app = createApp({
			log,
			scores: new FakeScoreIndex({
				scores: [SCORE],
				evidence: new Map([['sender.example|', [foreign]]]),
			}),
		});

		const page = (await (
			await app.request('/v1/subject/sender.example/evidence')
		).json()) as EvidencePage;

		expect(page.entries[0]?.proof).toBeUndefined();
	});
});
