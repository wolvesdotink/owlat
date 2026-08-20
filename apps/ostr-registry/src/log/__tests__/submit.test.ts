/**
 * Submission admission: form, signature, dedupe and the inclusion promise
 * (spec 05 §5.2). Content neutrality is the point of the accepted table — a
 * log takes an implausible claim from a nobody as readily as a plausible one
 * from a peer, as long as it is well formed and signed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	canonicalBytes,
	formatOstrKeyRecord,
	generateEd25519KeyPair,
	inclusionDeadline,
	inclusionPromiseCoversLeaf,
	signAttestation,
	verifyInclusionPromise,
} from '@owlat/ostr-core';
import { DEFAULT_MMD_SECONDS, SqliteRegistryLog } from '../index.js';
import {
	attestationFrom,
	type LogHarness,
	LOG_ID,
	makeLog,
	makeObserver,
	publishObserver,
	signedBy,
	trafficSummary,
	unwindowed,
} from './support.js';

const AT = '2026-08-20T10:00:00Z';

let harness: LogHarness;

beforeEach(() => {
	harness = makeLog(3600);
});

afterEach(() => {
	harness.cleanup();
});

describe('accepted submissions', () => {
	it('sequences well-formed, signed attestations from zero', async () => {
		const observer = publishObserver(harness.keys, 'mx.observer.test');
		const first = await harness.log.submit(attestationFrom(observer, 'example.com'), AT);
		const second = await harness.log.submit(attestationFrom(observer, 'other.test'), AT);

		expect(first).toMatchObject({ accepted: true, index: 0, duplicate: false });
		expect(second).toMatchObject({ accepted: true, index: 1, duplicate: false });
		expect(await harness.log.size()).toBe(2);
	});

	it.each([
		['traffic-summary', (o: string) => trafficSummary(o, 'example.com')],
		['posture', (o: string) => unwindowed('posture', o, 'example.com')],
		['vouch', (o: string) => unwindowed('vouch', o, 'example.com')],
	])('accepts a signed %s', async (_kind, build) => {
		const observer = publishObserver(harness.keys, 'mx.observer.test');
		const outcome = await harness.log.submit(signedBy(observer, build(observer.domain)), AT);
		expect(outcome.accepted).toBe(true);
	});

	it('accepts an implausible claim — the log judges form, never truth', async () => {
		const observer = publishObserver(harness.keys, 'mx.nobody.test');
		const wild = signedBy(observer, {
			...trafficSummary(observer.domain, 'well-known-bank.test', 999_999_999),
			subject: { domain: 'well-known-bank.test' },
		});
		expect((await harness.log.submit(wild, AT)).accepted).toBe(true);
	});

	it('accepts a key published alongside a retired one (rotation)', async () => {
		const observer = makeObserver('mx.rotating.test');
		const retired = generateEd25519KeyPair();
		harness.keys.publish(
			'mx.rotating.test',
			formatOstrKeyRecord(retired.publicKey),
			formatOstrKeyRecord(observer.publicKey)
		);
		expect((await harness.log.submit(attestationFrom(observer, 'example.com'), AT)).accepted).toBe(
			true
		);
	});
});

describe('rejected submissions', () => {
	it.each([
		['a number', 42, 'attestation must be a JSON object'],
		['a JSON string', '{"v":1}', 'attestation must be a JSON object'],
		['null', null, 'attestation must be a JSON object'],
	])('rejects %s outright', async (_label, candidate, message) => {
		const outcome = await harness.log.submit(candidate, AT);
		expect(outcome).toEqual({ accepted: false, errors: [message] });
	});

	it.each([
		['a wrong version', { v: 2 }, 'v must be 1'],
		['an unknown kind', { kind: 'gossip' }, 'kind must be a known attestation kind'],
		['an unknown envelope field', { note: 'hi' }, 'note is not a field of a v1 attestation'],
		['a bad observer', { observer: 'MX.Observer.Test' }, 'observer must be a lowercase FQDN'],
		['no subject', { subject: {} }, 'subject must carry a domain, an ip, or both'],
		['no window', { window: undefined }, 'window is required for kind traffic-summary'],
		[
			'a malformed signature',
			{ sig: 'ed25519:nope' },
			'sig must carry a base64 64-byte ed25519 signature',
		],
	])('rejects %s', async (_label, patch: Record<string, unknown>, message) => {
		const observer = publishObserver(harness.keys, 'mx.observer.test');
		const signed = attestationFrom(observer, 'example.com') as unknown as Record<string, unknown>;
		const candidate: Record<string, unknown> = { ...signed, ...patch };
		for (const [key, value] of Object.entries(patch)) {
			if (value === undefined) delete candidate[key];
		}

		const outcome = await harness.log.submit(candidate, AT);
		expect(outcome.accepted).toBe(false);
		if (outcome.accepted) return;
		expect(outcome.errors).toContain(message);
		expect(await harness.log.size()).toBe(0);
	});

	it('rejects an observer that publishes no key record', async () => {
		const observer = makeObserver('mx.silent.test');
		const outcome = await harness.log.submit(attestationFrom(observer, 'example.com'), AT);
		expect(outcome).toEqual({ accepted: false, errors: ['unknown observer key'] });
	});

	it.each([
		['a corrupt record', 'v=1; k=ed25519; p=not-base64!!'],
		['a revoked key', 'v=1; k=ed25519; p='],
		['a foreign algorithm', 'v=1; k=rsa; p=AAAA'],
	])('rejects an observer whose only record is %s', async (_label, record) => {
		const observer = makeObserver('mx.broken.test');
		harness.keys.publish('mx.broken.test', record);
		const outcome = await harness.log.submit(attestationFrom(observer, 'example.com'), AT);
		expect(outcome).toEqual({ accepted: false, errors: ['unknown observer key'] });
	});

	it('rejects a document signed by a key the observer does not publish', async () => {
		publishObserver(harness.keys, 'mx.observer.test');
		const impostor = makeObserver('mx.observer.test');
		const outcome = await harness.log.submit(attestationFrom(impostor, 'example.com'), AT);
		expect(outcome).toEqual({ accepted: false, errors: ['bad signature'] });
	});

	it('rejects a document tampered with after signing', async () => {
		const observer = publishObserver(harness.keys, 'mx.observer.test');
		const signed = attestationFrom(observer, 'example.com');
		const tampered = { ...signed, subject: { domain: 'victim.test' } };

		const outcome = await harness.log.submit(tampered, AT);
		expect(outcome).toEqual({ accepted: false, errors: ['bad signature'] });
		expect(await harness.log.size()).toBe(0);
	});

	it('rejects a submission clock that is not a UTC instant', async () => {
		const observer = publishObserver(harness.keys, 'mx.observer.test');
		const attestation = attestationFrom(observer, 'example.com');
		await expect(harness.log.submit(attestation, '2026-08-20T12:00:00+02:00')).rejects.toThrow(
			RangeError
		);
	});
});

describe('deduplication', () => {
	it('returns the existing index for identical canonical bytes', async () => {
		const observer = publishObserver(harness.keys, 'mx.observer.test');
		const attestation = attestationFrom(observer, 'example.com');

		const first = await harness.log.submit(attestation, AT);
		const again = await harness.log.submit(attestation, '2026-08-20T11:00:00Z');

		expect(first).toMatchObject({ accepted: true, index: 0, duplicate: false });
		expect(again).toMatchObject({ accepted: true, index: 0, duplicate: true });
		expect(await harness.log.size()).toBe(1);
	});

	it('dedupes across member order — the leaf is the canonical form', async () => {
		const observer = publishObserver(harness.keys, 'mx.observer.test');
		const attestation = attestationFrom(observer, 'example.com');
		const reordered = {
			sig: attestation.sig,
			body: attestation.body,
			window: attestation.window,
			subject: attestation.subject,
			observer: attestation.observer,
			kind: attestation.kind,
			v: attestation.v,
		};

		await harness.log.submit(attestation, AT);
		const again = await harness.log.submit(reordered, AT);
		expect(again).toMatchObject({ accepted: true, index: 0, duplicate: true });
		expect(await harness.log.size()).toBe(1);
	});

	it('issues a fresh promise for a duplicate', async () => {
		const observer = publishObserver(harness.keys, 'mx.observer.test');
		const attestation = attestationFrom(observer, 'example.com');

		const first = await harness.log.submit(attestation, AT);
		const again = await harness.log.submit(attestation, '2026-08-20T11:00:00Z');
		if (!first.accepted || !again.accepted) throw new Error('expected acceptance');

		expect(again.promise.timestamp).toBe('2026-08-20T11:00:00Z');
		expect(again.promise.sig).not.toBe(first.promise.sig);
		expect(verifyInclusionPromise(again.promise, harness.logKey.publicKey)).toBe(true);
	});

	it('answers a duplicate without looking the observer up', async () => {
		const observer = publishObserver(harness.keys, 'mx.observer.test');
		const attestation = attestationFrom(observer, 'example.com');
		await harness.log.submit(attestation, AT);
		expect(harness.keys.lookups).toEqual(['mx.observer.test']);

		const again = await harness.log.submit(attestation, '2026-08-20T11:00:00Z');
		expect(again).toMatchObject({ accepted: true, index: 0, duplicate: true });
		// The lookup is DNS in production and submission is open to the world:
		// replaying one captured attestation must not become a query flood at
		// the observer's nameservers. These bytes were verified when they were
		// first accepted and the leaf is already in the tree.
		expect(harness.keys.lookups).toEqual(['mx.observer.test']);
	});

	it('answers a duplicate after the observer withdrew its key', async () => {
		const observer = publishObserver(harness.keys, 'mx.observer.test');
		const attestation = attestationFrom(observer, 'example.com');
		await harness.log.submit(attestation, AT);

		harness.keys.publish('mx.observer.test');
		const again = await harness.log.submit(attestation, AT);
		// A log never unsays a leaf. Answering `unknown observer key` here would
		// deny an inclusion promise for evidence it is already serving.
		expect(again).toMatchObject({ accepted: true, index: 0, duplicate: true });
	});

	it('appends one leaf when the same new bytes arrive twice at once', async () => {
		const observer = publishObserver(harness.keys, 'mx.observer.test');
		const attestation = attestationFrom(observer, 'example.com');

		const resume = harness.keys.deferLookups();
		const both = Promise.all([
			harness.log.submit(attestation, AT),
			harness.log.submit(attestation, AT),
		]);
		resume();
		const [first, second] = await both;

		expect(await harness.log.size()).toBe(1);
		expect([first, second].map((outcome) => outcome.accepted && outcome.index)).toEqual([0, 0]);
		expect(
			[first, second].filter((outcome) => outcome.accepted && !outcome.duplicate)
		).toHaveLength(1);
	});

	it('treats a differently-signed copy of the same claim as a new leaf', async () => {
		const observer = publishObserver(harness.keys, 'mx.observer.test');
		const unsigned = trafficSummary(observer.domain, 'example.com');
		// Ed25519 is deterministic, so a second signature over the same bytes is
		// identical; a different observer's copy is what makes a second leaf.
		const other = publishObserver(harness.keys, 'mx.second.test');

		await harness.log.submit(signAttestation(unsigned, observer.privateKey), AT);
		const second = await harness.log.submit(
			signAttestation(trafficSummary(other.domain, 'example.com'), other.privateKey),
			AT
		);
		expect(second).toMatchObject({ accepted: true, index: 1, duplicate: false });
	});
});

describe('key directory failures', () => {
	it('propagates a lookup failure instead of blaming the submitter', async () => {
		const observer = publishObserver(harness.keys, 'mx.observer.test');
		harness.keys.outage = new Error('EAI_AGAIN _ostr.mx.observer.test');

		// A resolver outage is the log's problem — a 5xx the submitter should
		// retry — not a verdict that the document is unsigned. Turning it into
		// `unknown observer key` would tell an honest observer to fix DNS it has
		// already published correctly.
		await expect(harness.log.submit(attestationFrom(observer, 'example.com'), AT)).rejects.toThrow(
			/EAI_AGAIN/
		);
		expect(await harness.log.size()).toBe(0);
	});
});

describe('published MMD', () => {
	it.each([
		['zero', 0],
		['negative', -1],
		['fractional', 1.5],
		['not a number', Number.NaN],
	])('refuses an MMD that is %s', (_label, mmdSeconds) => {
		expect(
			() =>
				new SqliteRegistryLog({
					dbPath: ':memory:',
					logId: LOG_ID,
					privateKeyBase64: harness.logKey.privateKey,
					keys: harness.keys,
					mmdSeconds,
				})
		).toThrow(RangeError);
	});

	it('falls back to the published default when none is given', async () => {
		const log = new SqliteRegistryLog({
			dbPath: ':memory:',
			logId: LOG_ID,
			privateKeyBase64: harness.logKey.privateKey,
			keys: harness.keys,
		});
		try {
			expect(log.mmdSeconds).toBe(DEFAULT_MMD_SECONDS);
			const observer = publishObserver(harness.keys, 'mx.memory.test');
			const outcome = await log.submit(attestationFrom(observer, 'example.com'), AT);
			expect(outcome.accepted && outcome.promise.mmdSeconds).toBe(DEFAULT_MMD_SECONDS);
		} finally {
			log.close();
		}
	});
});

describe('inclusion promise', () => {
	it('is signed by the log over the submitted leaf, with the published MMD', async () => {
		const observer = publishObserver(harness.keys, 'mx.observer.test');
		const attestation = attestationFrom(observer, 'example.com');
		const outcome = await harness.log.submit(attestation, AT);
		if (!outcome.accepted) throw new Error('expected acceptance');

		expect(verifyInclusionPromise(outcome.promise, harness.logKey.publicKey)).toBe(true);
		expect(inclusionPromiseCoversLeaf(outcome.promise, canonicalBytes(attestation))).toBe(true);
		expect(outcome.promise.logId).toBe(LOG_ID);
		expect(outcome.promise.mmdSeconds).toBe(3600);
		expect(inclusionDeadline(outcome.promise)).toBe(Date.parse(AT) + 3600 * 1000);
	});

	it('does not verify under another key', async () => {
		const observer = publishObserver(harness.keys, 'mx.observer.test');
		const outcome = await harness.log.submit(attestationFrom(observer, 'example.com'), AT);
		if (!outcome.accepted) throw new Error('expected acceptance');
		expect(verifyInclusionPromise(outcome.promise, generateEd25519KeyPair().publicKey)).toBe(false);
	});
});
