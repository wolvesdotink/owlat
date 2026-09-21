/**
 * Phase-0 exit criteria, end to end: the real node, over HTTP, verified with
 * nothing but `@owlat/ostr-core`.
 *
 * The point of this test is that it trusts the server for nothing. It submits
 * a signed attestation, then checks every answer the way an outside party
 * would: the tree head against the log's published key, the audit path against
 * that head's root, the snapshot against the aggregator's key. If any of the
 * wiring in `index.ts` pointed at the wrong key, the wrong store or the wrong
 * clock, one of those verifications fails — which is exactly what a monitor
 * would see.
 *
 * It boots the production composition root, not a rehearsal of it: temp
 * directories, an ephemeral port, and a static key directory in place of DNS,
 * which is the one seam a test is allowed to move (resolving `_ostr.` for a
 * generated observer would need a real zone).
 *
 * Time is relative to the run. The scoring policy only admits evidence whose
 * window has closed at `asOf`, so a fixture with hard-coded 2026 timestamps
 * would pass or fail depending on the machine's clock.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	canonicalBytes,
	domainQueryName,
	generateEd25519KeyPair,
	signAttestation,
	verifyInclusion,
	verifySnapshotSignature,
	verifyTreeHead,
	type Attestation,
	type ScoreResult,
	type SignedInclusionPromise,
	type SignedTreeHead,
	type SnapshotFile,
} from '@owlat/ostr-core';
import type { OstrRegistryConfig } from '../config.js';
import { StaticKeyDirectory } from '../keys/index.js';
import { startRegistry, type RegistryNode } from '../index.js';

const OBSERVER = 'mx.observer.example';
const SUBJECT = 'sender.example';
/**
 * Two more subjects, so the tree the proofs are checked against has three
 * leaves. At size one the audit path is empty and `verifyInclusion` degenerates
 * into comparing the leaf hash with the root: sibling ordering, index
 * bit-walking and level construction would all go unexercised, and the
 * assertion could not tell a correct path from a broken one.
 */
const OTHER_SUBJECTS = ['second.example', 'third.example'] as const;
const ZONE_ORIGIN = 'ostr.example';
const LOG_ID = 'log.ostr.example';

const observerKeys = generateEd25519KeyPair();
const logKeys = generateEd25519KeyPair();
const aggregatorKeys = generateEd25519KeyPair();

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function instant(msFromNow: number): string {
	return new Date(Date.now() + msFromNow).toISOString();
}

/** A well-formed, honestly signed traffic summary about a subject. */
function attestation(subject: string = SUBJECT): Attestation {
	return signAttestation(
		{
			v: 1,
			kind: 'traffic-summary',
			observer: OBSERVER,
			subject: { domain: subject },
			window: { from: instant(-17 * DAY_MS), to: instant(-HOUR_MS) },
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

interface SubmitResponse {
	index: number;
	duplicate: boolean;
	promise: SignedInclusionPromise;
}

let dir: string;
let node: RegistryNode;
let submitted: Attestation;
let accepted: SubmitResponse;

async function get(path: string): Promise<Response> {
	return fetch(`${node.baseUrl}${path}`);
}

async function submit(candidate: unknown): Promise<Response> {
	return fetch(`${node.baseUrl}/v1/attestations`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(candidate),
	});
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'ostr-registry-e2e-'));
	const config: OstrRegistryConfig = {
		// Port 0: the OS picks, so parallel test files never collide.
		port: 0,
		listenAddress: '127.0.0.1',
		dbDir: dir,
		logId: LOG_ID,
		logPrivateKeyBase64: logKeys.privateKey,
		aggregatorPrivateKeyBase64: aggregatorKeys.privateKey,
		zoneOrigin: ZONE_ORIGIN,
		refBaseUrl: `https://${ZONE_ORIGIN}/s`,
		sthIntervalSeconds: 3600,
		refreshIntervalSeconds: 3600,
		mmdSeconds: 86_400,
		submitRatePerMinute: null,
		logLevel: 'silent',
		bootstrapObservers: null,
	};
	node = await startRegistry(config, {
		keys: new StaticKeyDirectory({ [OBSERVER]: [observerKeys.publicKey] }),
		logger: pino({ level: 'silent' }),
		// The schedules are the composition root's only timers; the test drives
		// the same two triggers by hand so nothing here waits on wall time.
		startTimers: false,
	});

	submitted = attestation();
	const response = await submit(submitted);
	expect(response.status).toBe(201);
	accepted = (await response.json()) as SubmitResponse;

	// Siblings for the leaf above, so its audit path is a real one.
	for (const subject of OTHER_SUBJECTS) {
		expect((await submit(attestation(subject))).status).toBe(201);
	}

	await node.publishHead();
	await node.refresh();
}, 30_000);

afterAll(async () => {
	await node.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe('registry node, end to end over HTTP', () => {
	it('accepts a signed submission with an inclusion promise', () => {
		expect(accepted.index).toBe(0);
		expect(accepted.duplicate).toBe(false);
		expect(accepted.promise.logId).toBe(LOG_ID);
		expect(accepted.promise.mmdSeconds).toBe(86_400);
	});

	it('answers a second copy of the same bytes with the index it already has', async () => {
		const response = await submit(submitted);

		expect(response.status).toBe(201);
		const repeat = (await response.json()) as SubmitResponse;
		expect(repeat).toMatchObject({ index: 0, duplicate: true });
	});

	it('refuses an attestation no allowed observer signed', async () => {
		const forged = signAttestation(
			{ ...attestation(), observer: 'stranger.example' },
			generateEd25519KeyPair().privateKey
		);

		const response = await submit(forged);

		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({ errors: ['unknown observer key'] });
	});

	it('publishes a tree head that verifies against the log key', async () => {
		const response = await get('/v1/log/sth');

		expect(response.status).toBe(200);
		const head = (await response.json()) as SignedTreeHead;
		expect(head.logId).toBe(LOG_ID);
		expect(head.treeSize).toBe(1 + OTHER_SUBJECTS.length);
		expect(verifyTreeHead(head, logKeys.publicKey)).toBe(true);
	});

	it('proves inclusion of the submitted leaf against that head', async () => {
		const head = (await (await get('/v1/log/sth')).json()) as SignedTreeHead;

		// By leaf hash, the only coordinate a submitter holding an inclusion
		// promise has — and the form that exercises the lookup the composition
		// root injects.
		const response = await get(
			`/v1/log/proof/inclusion?hash=${accepted.promise.leafHash}&size=${head.treeSize}`
		);

		expect(response.status).toBe(200);
		const proof = (await response.json()) as string[];
		// Three leaves: the sibling leaf, then the hash of the second level's
		// subtree. An empty path here would mean the assertion below proves
		// nothing but "the leaf hash is the root".
		expect(proof).toHaveLength(2);
		expect(
			verifyInclusion({
				leaf: canonicalBytes(submitted),
				index: accepted.index,
				treeSize: head.treeSize,
				proof: proof.map((hash) => Buffer.from(hash, 'hex')),
				root: Buffer.from(head.rootHash, 'hex'),
			})
		).toBe(true);
	});

	it('serves the subject a tier and the evidence behind it', async () => {
		const response = await get(`/v1/subject/${SUBJECT}`);

		expect(response.status).toBe(200);
		const score = (await response.json()) as ScoreResult;
		expect(score.subject).toEqual({ domain: SUBJECT });
		expect(score.tier).toBe('establishing');
		expect(score.explanation.length).toBeGreaterThan(0);

		const evidence = (await (await get(`/v1/subject/${SUBJECT}/evidence`)).json()) as {
			head: SignedTreeHead | null;
			entries: Array<{ attestation: Attestation; index: number; proof?: string[] }>;
		};
		expect(evidence.entries).toHaveLength(1);
		const entry = evidence.entries[0];
		expect(entry?.attestation).toEqual(submitted);
		// The page's own proof, against the head it serves alongside it — the
		// thing a client is told to verify instead of trusting the aggregator.
		expect(entry?.proof).toHaveLength(2);
		expect(evidence.head).not.toBeNull();
		expect(
			verifyInclusion({
				leaf: canonicalBytes(submitted),
				index: entry?.index ?? -1,
				treeSize: evidence.head?.treeSize ?? 0,
				proof: (entry?.proof ?? []).map((hash) => Buffer.from(hash, 'hex')),
				root: Buffer.from(evidence.head?.rootHash ?? '', 'hex'),
			})
		).toBe(true);
	});

	it('serves a snapshot that verifies against the aggregator key', async () => {
		const response = await get('/v1/snapshot');

		expect(response.status).toBe(200);
		const snapshot = (await response.json()) as SnapshotFile;
		expect(verifySnapshotSignature(snapshot, aggregatorKeys.publicKey)).toBe(true);
		expect(snapshot.entries).toEqual(
			[SUBJECT, ...OTHER_SUBJECTS]
				.map((domain) => ({
					subject: { domain },
					tier: 'establishing',
					score: expect.any(Number) as unknown as number,
				}))
				.sort((a, b) => a.subject.domain.localeCompare(b.subject.domain))
		);
		// The snapshot declares the head it was computed against, so a consumer
		// can fetch the log at that size and recompute the whole thing.
		expect(snapshot.heads).toHaveLength(1);
		expect(verifyTreeHead(snapshot.heads[0] as SignedTreeHead, logKeys.publicKey)).toBe(true);
	});

	it('generates a zone carrying the subject TXT answer', async () => {
		const response = await get('/v1/zone');

		expect(response.status).toBe(200);
		const zone = await response.text();
		const owner = domainQueryName(SUBJECT, ZONE_ORIGIN);
		expect(zone).toContain(`${owner}.\t3600\tIN\tTXT\t`);
		expect(zone).toContain('tier=establishing');
		expect(zone).toContain(`$ORIGIN ${ZONE_ORIGIN}.`);
	});

	it('answers the liveness probe without touching the stores', async () => {
		const response = await get('/healthz');

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});
});
