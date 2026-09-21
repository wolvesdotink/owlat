import type { DiffFeedEntry, SnapshotFile } from '@owlat/ostr-core';
import { describe, expect, it } from 'vitest';
import type { ScoreIndex } from '../../contracts.js';
import { createApp } from '../app.js';
import { FakeScoreIndex, PagedFakeScoreIndex, type FakeScoreIndexState } from './fakes.js';
import { makeLog, makeObserver, SNAPSHOT } from './fixtures.js';

const ZONE = [
	'$TTL 3600',
	'sender.example.q.ostr.test. IN TXT "v=1; tier=trusted; score=87; policy=ostr-policy-v1; asof=2026-08-20T06:00:00Z"',
	'',
].join('\n');

const DIFFS: DiffFeedEntry[] = [
	{
		seq: 1,
		asOf: '2026-08-20T06:00:00Z',
		entry: { subject: { domain: 'a.example' }, tier: 'trusted', score: 80 },
	},
	{
		seq: 2,
		asOf: '2026-08-20T07:00:00Z',
		entry: { subject: { domain: 'b.example' }, tier: 'warned', score: 30 },
	},
	{
		seq: 3,
		asOf: '2026-08-20T08:00:00Z',
		entry: { subject: { ip: '192.0.2.7' }, tier: 'flagged', score: 5 },
	},
];

function appFor(scores: ScoreIndex) {
	const { log } = makeLog([makeObserver()]);
	return createApp({ log, scores });
}

function setup(state: FakeScoreIndexState = {}) {
	return appFor(new FakeScoreIndex(state));
}

describe('GET /v1/snapshot', () => {
	it('answers 404 before the first refresh', async () => {
		const res = await setup().request('/v1/snapshot');

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'no snapshot published yet' });
	});

	it('serves the signed snapshot byte-for-byte as signed', async () => {
		const res = await setup({ snapshot: SNAPSHOT }).request('/v1/snapshot');

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('application/json');
		expect((await res.json()) as SnapshotFile).toEqual(SNAPSHOT);
	});

	it('lets a CDN hold the snapshot and answers a conditional request with 304', async () => {
		const app = setup({ snapshot: SNAPSHOT });

		const first = await app.request('/v1/snapshot');
		const etag = first.headers.get('etag');
		const second = await app.request('/v1/snapshot', {
			headers: { 'if-none-match': etag ?? '' },
		});

		expect(first.headers.get('cache-control')).toBe('public, max-age=300');
		expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
		expect(second.status).toBe(304);
		expect(await second.text()).toBe('');
	});

	it('re-tags the moment the aggregator publishes a different snapshot', async () => {
		// The body and its tag are held between requests, so the held pair has to
		// be keyed on the snapshot itself: a refresh must not be served under the
		// previous tag, which a client would answer with a 304 forever.
		const scores = new FakeScoreIndex({ snapshot: SNAPSHOT });
		const app = appFor(scores);
		const first = await app.request('/v1/snapshot');
		const republished: SnapshotFile = { ...SNAPSHOT, asOf: '2026-08-20T07:00:00Z' };
		scores.republish({ snapshot: republished });

		const second = await app.request('/v1/snapshot');

		expect(second.headers.get('etag')).not.toBe(first.headers.get('etag'));
		expect((await second.json()) as SnapshotFile).toEqual(republished);
		// And the tag a held body carries still matches that body.
		const third = await app.request('/v1/snapshot', {
			headers: { 'if-none-match': second.headers.get('etag') ?? '' },
		});
		expect(third.status).toBe(304);
	});
});

describe('GET /v1/diff', () => {
	it('serves the whole feed by default when it fits a page', async () => {
		const res = await setup({ diffs: DIFFS }).request('/v1/diff');

		expect(res.status).toBe(200);
		expect((await res.json()) as DiffFeedEntry[]).toHaveLength(3);
	});

	it('caps an unpaged request at one page rather than the whole journal', async () => {
		const diffs: DiffFeedEntry[] = Array.from({ length: 500 }, (_, i) => ({
			seq: i + 1,
			asOf: '2026-08-20T06:00:00Z',
			entry: { subject: { domain: `s${i}.example` }, tier: 'trusted', score: 80 },
		}));

		const res = await setup({ diffs }).request('/v1/diff');

		const page = (await res.json()) as DiffFeedEntry[];
		expect(page).toHaveLength(50);
		expect(page[0]?.seq).toBe(1);
		// The client resumes from the last seq it saw, which is the loop
		// `syncDiff` in @owlat/ostr-client already runs.
		const next = await setup({ diffs }).request(`/v1/diff?since=${page[49]?.seq ?? 0}&limit=100`);
		expect((await next.json()) as DiffFeedEntry[]).toHaveLength(100);
	});

	it('is cacheable only briefly: a held page hides entries that exist', async () => {
		const res = await setup({ diffs: DIFFS }).request('/v1/diff');

		expect(res.headers.get('cache-control')).toBe('public, max-age=60');
	});

	it('clamps limit to the page maximum', async () => {
		const diffs: DiffFeedEntry[] = Array.from({ length: 300 }, (_, i) => ({
			seq: i + 1,
			asOf: '2026-08-20T06:00:00Z',
			entry: { subject: { domain: `s${i}.example` }, tier: 'trusted', score: 80 },
		}));

		const res = await setup({ diffs }).request('/v1/diff?limit=5000');

		expect((await res.json()) as DiffFeedEntry[]).toHaveLength(100);
	});

	it('pushes the page bound into an index that can read a bounded page', async () => {
		// Otherwise every anonymous request reads a page fifty times the size of
		// the answer and throws the rest away.
		const diffs: DiffFeedEntry[] = Array.from({ length: 500 }, (_, i) => ({
			seq: i + 1,
			asOf: '2026-08-20T06:00:00Z',
			entry: { subject: { domain: `s${i}.example` }, tier: 'trusted', score: 80 },
		}));
		const scores = new PagedFakeScoreIndex({ diffs });

		const res = await appFor(scores).request('/v1/diff?since=7&limit=100');

		expect((await res.json()) as DiffFeedEntry[]).toHaveLength(100);
		expect(scores.pageCalls).toEqual([{ seq: 7, limit: 100 }]);
	});

	it('serves only entries after since', async () => {
		const res = await setup({ diffs: DIFFS }).request('/v1/diff?since=2');

		const entries = (await res.json()) as DiffFeedEntry[];
		expect(entries.map((entry) => entry.seq)).toEqual([3]);
	});

	it.each([
		['a negative since', 'since=-1', 'since must be a non-negative integer'],
		['a fractional since', 'since=1.5', 'since must be a non-negative integer'],
		['an empty since', 'since=', 'since must not be empty'],
		['a repeated since', 'since=1&since=2', 'since must be given at most once'],
		['a zero limit', 'limit=0', 'limit must be at least 1'],
	])('answers 400 for %s', async (_label, query, message) => {
		const res = await setup({ diffs: DIFFS }).request(`/v1/diff?${query}`);

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: message });
	});
});

describe('GET /v1/zone', () => {
	it('serves the zone as text/plain', async () => {
		const res = await setup({ zone: ZONE }).request('/v1/zone');

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
		expect(await res.text()).toBe(ZONE);
	});

	it('serves an empty zone before the first refresh', async () => {
		const res = await setup().request('/v1/zone');

		expect(res.status).toBe(200);
		expect(await res.text()).toBe('');
	});

	it('lets a CDN hold the zone and answers a conditional request with 304', async () => {
		const app = setup({ zone: ZONE });

		const first = await app.request('/v1/zone');
		const second = await app.request('/v1/zone', {
			headers: { 'if-none-match': first.headers.get('etag') ?? '' },
		});

		expect(first.headers.get('cache-control')).toBe('public, max-age=300');
		expect(second.status).toBe(304);
	});

	it('re-tags the zone within one node once a refresh has rewritten it', async () => {
		const scores = new FakeScoreIndex({ zone: ZONE });
		const app = appFor(scores);
		const first = await app.request('/v1/zone');
		const rewritten = `${ZONE}other.example. IN TXT "v=1"\n`;
		scores.republish({ zone: rewritten });

		const second = await app.request('/v1/zone', {
			headers: { 'if-none-match': first.headers.get('etag') ?? '' },
		});

		expect(second.status).toBe(200);
		expect(await second.text()).toBe(rewritten);
	});

	it('re-sends when the zone has changed under the tag', async () => {
		const stale = setup({ zone: ZONE }).request('/v1/zone');
		const etag = (await stale).headers.get('etag') ?? '';

		const res = await setup({ zone: `${ZONE}other.example. IN TXT "v=1"\n` }).request('/v1/zone', {
			headers: { 'if-none-match': etag },
		});

		expect(res.status).toBe(200);
		expect(res.headers.get('etag')).not.toBe(etag);
	});
});

describe('GET /healthz', () => {
	it('answers ok', async () => {
		const res = await setup().request('/healthz');

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});
});
