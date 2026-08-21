/**
 * The consumer client the MX asks (plan §8.3, spec 08 §8.3).
 *
 * The property that matters here is a PRIVACY one, not a caching one: a DNS
 * tier query tells the aggregator, and every resolver on the way, who is
 * sending this instance mail, and over a working day those queries are a
 * readable map of its correspondents. The signed snapshot answers the same
 * question from a file the instance already holds. So the assertions below are
 * mostly about which lookups DID NOT happen.
 *
 * The rest is what a snapshot fetch must never be allowed to do to a mail
 * server: unbounded bytes, an unverified document adopted, or a background
 * timer that outlives the listener that started it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateEd25519KeyPair, signSnapshot, type SnapshotFile } from '@owlat/ostr-core';
import { SNAPSHOT_PATH, type ResolveTxt } from '@owlat/ostr-client';
import type { MtaConfig } from '../../config.js';
import {
	createAggregatorFetchJson,
	createOstrConsumer,
	OSTR_SNAPSHOT_REFRESH_MS,
	type OstrConsumerConfig,
} from '../ostrClient.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ZONE = 'ostr.test';
const AS_OF = '2026-08-20T06:00:00Z';
const TRUSTED = 'v=1; tier=trusted; score=82; policy=v1; asof=2026-08-20T00:00:00Z';

const keys = generateEd25519KeyPair();

/** The as-of head set a snapshot is computed against; one log is enough here. */
const HEAD = {
	v: 1 as const,
	logId: 'log.test',
	treeSize: 12,
	rootHash: 'b'.repeat(64),
	timestamp: AS_OF,
	sig: 'ed25519:aGVhZC1zaWduYXR1cmU=',
};

function snapshotOf(tier: 'trusted' | 'flagged', score: number, signWith = keys.privateKey) {
	return signSnapshot(
		{
			v: 1,
			policy: 'ostr-policy-v1',
			asOf: AS_OF,
			heads: [HEAD],
			entries: [{ subject: { domain: 'example.test' }, tier, score }],
		},
		signWith
	);
}

function makeConfig(overrides: Partial<MtaConfig> = {}): OstrConsumerConfig {
	return {
		ostrEnabled: true,
		ostrZone: ZONE,
		ostrAggregatorUrl: 'https://registry.test',
		ostrAggregatorPublicKey: keys.publicKey,
		...overrides,
	} as OstrConsumerConfig;
}

/** A TXT resolver that records every name it was asked about. */
function zoneResolver(zone: Record<string, string[][]> = {}): ResolveTxt & { calls: string[] } {
	const calls: string[] = [];
	const resolve = async (name: string) => {
		calls.push(name);
		return zone[name] ?? [];
	};
	return Object.assign(resolve, { calls });
}

/** A `fetchJson` serving one snapshot document, counting requests. */
function snapshotFeed(snapshot: SnapshotFile | Error) {
	const paths: string[] = [];
	return Object.assign(
		async (path: string): Promise<unknown> => {
			paths.push(path);
			if (snapshot instanceof Error) throw snapshot;
			return snapshot;
		},
		{ paths }
	);
}

describe('createOstrConsumer — off means off', () => {
	it('builds nothing at all when the instance consumes no registry', () => {
		expect(
			createOstrConsumer(makeConfig({ ostrEnabled: false }), { resolveTxt: zoneResolver() })
		).toBeNull();
	});
});

describe('createOstrConsumer — the snapshot answers, so DNS is not asked', () => {
	it('adopts a verified snapshot and answers from it without a query', async () => {
		const resolveTxt = zoneResolver({ [`example.test.q.${ZONE}`]: [[TRUSTED]] });
		const fetchJson = snapshotFeed(snapshotOf('flagged', 4));
		const consumer = createOstrConsumer(makeConfig(), { resolveTxt, fetchJson });

		await consumer?.refresh();
		const answer = await consumer?.client.resolveTier({ domain: 'example.test' });

		expect(fetchJson.paths).toEqual([SNAPSHOT_PATH]);
		// The snapshot's `flagged`, not the zone's `trusted`: local data wins, and
		// the resolver never learned who this instance is corresponding with.
		expect(answer).toMatchObject({ status: 'answer' });
		expect(answer?.status === 'answer' && answer.answer.tier).toBe('flagged');
		expect(answer?.status === 'answer' && answer.answer.source).toBe('snapshot');
		expect(answer?.status === 'answer' && answer.answer.verified).toBe(true);
		expect(resolveTxt.calls).toEqual([]);
	});

	it('falls back to DNS for a subject the snapshot does not cover', async () => {
		const resolveTxt = zoneResolver({ [`other.test.q.${ZONE}`]: [[TRUSTED]] });
		const consumer = createOstrConsumer(makeConfig(), {
			resolveTxt,
			fetchJson: snapshotFeed(snapshotOf('flagged', 4)),
		});

		await consumer?.refresh();
		const answer = await consumer?.client.resolveTier({ domain: 'other.test' });

		expect(answer?.status === 'answer' && answer.answer.source).toBe('dns');
		expect(resolveTxt.calls).toEqual([`other.test.q.${ZONE}`]);
	});

	it('refuses a snapshot signed by anyone else and keeps serving without it', async () => {
		const resolveTxt = zoneResolver({ [`example.test.q.${ZONE}`]: [[TRUSTED]] });
		const impostor = generateEd25519KeyPair();
		const consumer = createOstrConsumer(makeConfig(), {
			resolveTxt,
			fetchJson: snapshotFeed(snapshotOf('flagged', 4, impostor.privateKey)),
		});

		await consumer?.refresh();
		const answer = await consumer?.client.resolveTier({ domain: 'example.test' });

		// Nothing was adopted, so the answer comes from the (DNSSEC-signed) zone.
		expect(answer?.status === 'answer' && answer.answer.tier).toBe('trusted');
		expect(answer?.status === 'answer' && answer.answer.source).toBe('dns');
	});

	it('survives an aggregator that is down', async () => {
		const consumer = createOstrConsumer(makeConfig(), {
			resolveTxt: zoneResolver(),
			fetchJson: snapshotFeed(new Error('ECONNREFUSED')),
		});

		await expect(consumer?.refresh()).resolves.toBeUndefined();
	});

	it('runs zone-only when no aggregator is configured — the documented leaky mode', async () => {
		const resolveTxt = zoneResolver({ [`example.test.q.${ZONE}`]: [[TRUSTED]] });
		const consumer = createOstrConsumer(
			makeConfig({ ostrAggregatorUrl: undefined, ostrAggregatorPublicKey: undefined }),
			{ resolveTxt }
		);

		await consumer?.refresh();
		const answer = await consumer?.client.resolveTier({ domain: 'example.test' });

		expect(answer?.status === 'answer' && answer.answer.source).toBe('dns');
	});
});

describe('createOstrConsumer — the refresh timer belongs to the listener', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('refreshes on start, again on schedule, and never after stop', async () => {
		const fetchJson = snapshotFeed(snapshotOf('trusted', 90));
		const consumer = createOstrConsumer(makeConfig(), { resolveTxt: zoneResolver(), fetchJson });

		consumer?.start();
		consumer?.start(); // idempotent: a second call must not double the schedule
		await vi.advanceTimersByTimeAsync(OSTR_SNAPSHOT_REFRESH_MS + 1);
		expect(fetchJson.paths).toHaveLength(2);

		consumer?.stop();
		await vi.advanceTimersByTimeAsync(OSTR_SNAPSHOT_REFRESH_MS * 5);
		expect(fetchJson.paths).toHaveLength(2);
	});
});

describe('createAggregatorFetchJson', () => {
	function response(body: string, init: ResponseInit = {}): Response {
		return new Response(body, init);
	}

	it('resolves a path against the configured base and decodes JSON', async () => {
		const seen: string[] = [];
		const fetchJson = createAggregatorFetchJson('https://registry.test/base/', {
			fetchImpl: async (input) => {
				seen.push(String(input));
				return response('{"ok":true}');
			},
		});

		expect(await fetchJson('/v1/snapshot')).toEqual({ ok: true });
		expect(seen).toEqual(['https://registry.test/v1/snapshot']);
	});

	it('rejects a non-2xx answer instead of parsing the error page', async () => {
		const fetchJson = createAggregatorFetchJson('https://registry.test', {
			fetchImpl: async () => response('nope', { status: 503 }),
		});

		await expect(fetchJson('/v1/snapshot')).rejects.toThrow('responded 503');
	});

	it('refuses a body that declares more than the cap', async () => {
		const fetchJson = createAggregatorFetchJson('https://registry.test', {
			maxBytes: 64,
			fetchImpl: async () => response('{}', { headers: { 'content-length': '999999' } }),
		});

		await expect(fetchJson('/v1/snapshot')).rejects.toThrow('cap 64');
	});

	it('refuses a body that exceeds the cap MID-STREAM, with no length declared', async () => {
		// The case a `content-length` check alone misses: the signature is only
		// checked once the document is parsed, so everything read before that is
		// unauthenticated bytes from whoever answered the URL.
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('x'.repeat(128)));
				controller.close();
			},
		});
		const fetchJson = createAggregatorFetchJson('https://registry.test', {
			maxBytes: 64,
			fetchImpl: async () => new Response(stream),
		});

		await expect(fetchJson('/v1/snapshot')).rejects.toThrow('exceeded 64 bytes');
	});
});
