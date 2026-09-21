import { verifyInclusionPromise, type SignedInclusionPromise } from '@owlat/ostr-core';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { makeLog, makeObserver, trafficSummary } from './fixtures.js';
import { FakeScoreIndex } from './fakes.js';

const NOW = '2026-08-20T12:00:00.000Z';

function setup(options: { maxBodyBytes?: number } = {}) {
	const observer = makeObserver();
	const { log, logPublicKey } = makeLog([observer]);
	const scores = new FakeScoreIndex();
	const app = createApp({ log, scores }, { now: () => NOW, ...options });
	return { app, log, logPublicKey, observer };
}

function post(body: string, headers: Record<string, string> = {}): RequestInit {
	return { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } };
}

describe('POST /v1/attestations', () => {
	it('accepts a real signed attestation and returns index, duplicate and promise', async () => {
		const { app, logPublicKey, observer } = setup();
		const attestation = trafficSummary(observer);

		const res = await app.request('/v1/attestations', post(JSON.stringify(attestation)));

		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			index: number;
			duplicate: boolean;
			promise: SignedInclusionPromise;
		};
		expect(body.index).toBe(0);
		expect(body.duplicate).toBe(false);
		expect(body.promise.timestamp).toBe(NOW);
		// The promise the API served is the log's real signed commitment.
		expect(verifyInclusionPromise(body.promise, logPublicKey)).toBe(true);
	});

	it('reports a re-submission as a duplicate at the original index', async () => {
		const { app, observer } = setup();
		const payload = JSON.stringify(trafficSummary(observer));

		const first = await app.request('/v1/attestations', post(payload));
		const second = await app.request('/v1/attestations', post(payload));

		expect(first.status).toBe(201);
		expect(second.status).toBe(201);
		const body = (await second.json()) as { index: number; duplicate: boolean };
		expect(body).toMatchObject({ index: 0, duplicate: true });
	});

	it('serves an inclusion proof for what it accepted', async () => {
		const { app, log, observer } = setup();
		await app.request('/v1/attestations', post(JSON.stringify(trafficSummary(observer))));
		await app.request(
			'/v1/attestations',
			post(JSON.stringify(trafficSummary(observer, { domain: 'other.example' })))
		);
		await log.publishHead(NOW);

		const res = await app.request('/v1/log/proof/inclusion?index=0&size=2');

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(await log.inclusionProof(0, 2));
	});

	it('rejects a structurally invalid attestation with 422 and every reason', async () => {
		const { app } = setup();
		const broken = { v: 1, kind: 'not-a-kind', observer: 'NOT A DOMAIN', subject: {}, body: 1 };

		const res = await app.request('/v1/attestations', post(JSON.stringify(broken)));

		expect(res.status).toBe(422);
		const body = (await res.json()) as { errors: string[] };
		expect(body.errors.length).toBeGreaterThan(1);
		expect(body.errors.join('\n')).toContain('kind');
	});

	it('rejects an attestation signed by a key the observer never published', async () => {
		const { app } = setup();
		const stranger = makeObserver('mx.observer.test');

		const res = await app.request(
			'/v1/attestations',
			post(JSON.stringify(trafficSummary(stranger)))
		);

		expect(res.status).toBe(422);
		const body = (await res.json()) as { errors: string[] };
		expect(body.errors[0]).toContain('_ostr.mx.observer.test');
	});

	it('rejects a body mutated after signing', async () => {
		const { app, observer } = setup();
		const attestation = trafficSummary(observer);
		const tampered = { ...attestation, body: { ...attestation.body, messages: 999_999 } };

		const res = await app.request('/v1/attestations', post(JSON.stringify(tampered)));

		expect(res.status).toBe(422);
	});

	it('answers 400 for a malformed JSON body', async () => {
		const { app } = setup();

		const res = await app.request('/v1/attestations', post('{"v":1,'));

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'request body must be valid JSON' });
	});

	it('answers 400 for an empty body', async () => {
		const { app } = setup();

		const res = await app.request('/v1/attestations', { method: 'POST' });

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'request body must not be empty' });
	});

	it('answers 413 when the streamed body exceeds the cap', async () => {
		const { app, observer } = setup({ maxBodyBytes: 256 });
		const attestation = trafficSummary(observer);
		const padded = JSON.stringify({ ...attestation, padding: 'x'.repeat(1024) });

		const res = await app.request('/v1/attestations', post(padded));

		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: 'body must be at most 256 bytes' });
	});

	it('answers 413 on a declared content-length over the cap without reading the body', async () => {
		const { app } = setup({ maxBodyBytes: 256 });

		const res = await app.request('/v1/attestations', post('{}', { 'content-length': '100000' }));

		expect(res.status).toBe(413);
	});

	it('answers 415 for a non-JSON content type', async () => {
		const { app, observer } = setup();

		const res = await app.request(
			'/v1/attestations',
			post(JSON.stringify(trafficSummary(observer)), { 'content-type': 'text/plain' })
		);

		expect(res.status).toBe(415);
		expect(await res.json()).toEqual({ error: 'content-type text/plain is not JSON' });
	});

	it('accepts a JSON content type with parameters', async () => {
		const { app, observer } = setup();

		const res = await app.request(
			'/v1/attestations',
			post(JSON.stringify(trafficSummary(observer)), {
				'content-type': 'application/json; charset=utf-8',
			})
		);

		expect(res.status).toBe(201);
	});

	it('answers 404 JSON for a GET on the submission endpoint', async () => {
		const { app } = setup();

		const res = await app.request('/v1/attestations');

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'not found' });
	});
});
