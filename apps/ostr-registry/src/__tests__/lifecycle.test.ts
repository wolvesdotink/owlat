/**
 * Restart behaviour of the composition root.
 *
 * Both assertions here are about what a restart must not do. It must not
 * strand the log's single-writer lock — a node that cannot be restarted is a
 * node that cannot be upgraded — and it must not leave leaves that were
 * appended before the stop uncovered by any head, because until a head covers
 * them nothing about them can be proven to the submitter that holds a promise.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateEd25519KeyPair, signAttestation, verifyTreeHead } from '@owlat/ostr-core';
import type { OstrRegistryConfig } from '../config.js';
import { KeyLookupOverloadError, StaticKeyDirectory } from '../keys/index.js';
import { startRegistry, type RegistryNode } from '../index.js';

const OBSERVER = 'mx.observer.example';
const observerKeys = generateEd25519KeyPair();
const logKeys = generateEd25519KeyPair();
const silent = pino({ level: 'silent' });

let dir: string;
let config: OstrRegistryConfig;
let running: RegistryNode[] = [];

async function start(overrides: Partial<OstrRegistryConfig> = {}): Promise<RegistryNode> {
	return startRegistry(
		{ ...config, ...overrides },
		{
			keys: new StaticKeyDirectory({ [OBSERVER]: [observerKeys.publicKey] }),
			logger: silent,
			startTimers: false,
		}
	);
}

async function boot(overrides: Partial<OstrRegistryConfig> = {}): Promise<RegistryNode> {
	const node = await start(overrides);
	running.push(node);
	return node;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'ostr-registry-life-'));
	config = {
		port: 0,
		listenAddress: '127.0.0.1',
		dbDir: join(dir, 'data'),
		logId: 'log.ostr.example',
		logPrivateKeyBase64: logKeys.privateKey,
		aggregatorPrivateKeyBase64: generateEd25519KeyPair().privateKey,
		zoneOrigin: 'ostr.example',
		refBaseUrl: 'https://ostr.example/s',
		sthIntervalSeconds: 3600,
		refreshIntervalSeconds: 3600,
		mmdSeconds: 86_400,
		submitRatePerMinute: null,
		logLevel: 'silent',
		bootstrapObservers: null,
	};
	running = [];
});

afterEach(async () => {
	for (const node of running) await node.stop();
	rmSync(dir, { recursive: true, force: true });
});

function trafficSummary(): unknown {
	const to = new Date(Date.now() - 3_600_000).toISOString();
	const from = new Date(Date.now() - 17 * 86_400_000).toISOString();
	return signAttestation(
		{
			v: 1,
			kind: 'traffic-summary',
			observer: OBSERVER,
			subject: { domain: 'sender.example' },
			window: { from, to },
			body: {
				messages: 800,
				spfPass: 800,
				dkimPass: 800,
				dmarcPass: 800,
				tlsInbound: 800,
				uniqueRecipientsBucket: 4,
				bounceRateBucket: 0,
			},
		},
		observerKeys.privateKey
	);
}

describe('restart', () => {
	it('releases the writer lock and reopens the same log', async () => {
		const first = await boot();
		const outcome = await first.log.submit(trafficSummary(), new Date().toISOString());
		expect(outcome.accepted).toBe(true);
		await first.stop();
		// Idempotent: a SIGTERM racing an explicit shutdown must not double-close.
		await first.stop();

		const second = await boot();

		expect(await second.log.size()).toBe(1);
		expect(second.port).toBeGreaterThan(0);

		// Idempotent for CONCURRENT callers too, which is the racing case a
		// boolean flag gets wrong: every await must resolve on the same drain,
		// not one of them on a flag set before the first one. A caller that
		// returns early here goes on to delete the data directory under a live
		// writer — so the proof is that a third boot still gets the lock.
		await Promise.all([second.stop(), second.stop(), second.stop()]);
		expect(await (await boot()).log.size()).toBe(1);
	});

	it('covers leaves the previous process left uncovered, and mints nothing otherwise', async () => {
		const first = await boot();
		// The boot head covers the empty tree; this leaf arrives after it.
		await first.log.submit(trafficSummary(), new Date().toISOString());
		await first.stop();

		const second = await boot();
		const covering = await second.log.head();
		if (covering === null) throw new Error('the restart published no head');
		expect(covering.treeSize).toBe(1);
		expect(verifyTreeHead(covering, logKeys.publicKey)).toBe(true);
		await second.stop();

		// Nothing was appended in between, so this boot must publish no head.
		const third = await boot();
		expect((await third.log.head())?.timestamp).toBe(covering.timestamp);
	});
});

describe('a saturated key directory', () => {
	it('answers 503 with Retry-After instead of blaming the submission', async () => {
		// The bytes are fine and a retry will work: refusing to issue one more
		// outbound lookup is a load condition, so the answer must be retryable
		// and must not read as a rejection of the evidence.
		const node = await startRegistry(config, {
			keys: {
				verifyingKeys: () => Promise.reject(new KeyLookupOverloadError('flood.example')),
			},
			logger: silent,
			startTimers: false,
		});
		running.push(node);

		const response = await fetch(`${node.baseUrl}/v1/attestations`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(trafficSummary()),
		});

		expect(response.status).toBe(503);
		expect(response.headers.get('retry-after')).toBe('5');
		expect(await response.json()).toEqual({ error: 'key discovery is saturated; retry shortly' });
	});
});

describe('a boot that cannot bind', () => {
	it('reports the failure instead of hanging on it', async () => {
		const first = await boot();

		// Without a listener on the server's `error` event, the bind failure has
		// nowhere to go and the boot promise never settles — a node that neither
		// starts nor exits, which no supervisor can act on.
		await expect(start({ dbDir: join(dir, 'second'), port: first.port })).rejects.toThrow(
			/EADDRINUSE/
		);
	});
});
