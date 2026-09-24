// @vitest-environment node
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { requestUpdater } from '../updater';

/**
 * The updater transport against a fake updater that answers late.
 *
 * Node's fetch (undici) fails a response whose headers take longer than its
 * `headersTimeout` (300 s by default), whatever AbortSignal the caller passes,
 * so `/update` and `/apply-profiles` were cut off at five minutes although the
 * routes allow 30 and 10. Waiting five real minutes is not an option here, so
 * the tests shrink undici's global dispatcher to a 200 ms `headersTimeout` and
 * let the fake updater answer after 2.5 s: the same race at a smaller scale.
 * (undici checks its header deadline on a coarse timer that ticks about once
 * a second, so the answer has to come well after one tick.)
 */

const HEADERS_TIMEOUT_MS = 200;
const ANSWER_AFTER_MS = 2500;

const DISPATCHER = Symbol.for('undici.globalDispatcher.1');
type DispatcherHolder = { [DISPATCHER]?: { constructor: new (opts: object) => unknown } };

let server: Server;
let baseUrl: URL;
let received: { url?: string; method?: string; secret?: string; body: string }[] = [];
let originalDispatcher: unknown;

async function readSmallBody(req: IncomingMessage): Promise<string> {
	let body = '';
	for await (const chunk of req) {
		body += String(chunk);
		if (body.length > 4096) throw new Error('test request body over 4 KiB');
	}
	return body;
}

beforeAll(async () => {
	server = createServer(async (req, res) => {
		const body = await readSmallBody(req);
		if (req.url === '/warm-up') return void res.end();
		received.push({
			url: req.url,
			method: req.method,
			secret: req.headers['x-instance-secret'] as string | undefined,
			body,
		});
		setTimeout(() => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ success: true, echo: body }));
		}, ANSWER_AFTER_MS);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);

	// Load Node's fetch so its global dispatcher exists, then swap in one of the
	// same class with the shortened header deadline.
	await fetch(new URL('/warm-up', baseUrl), { signal: AbortSignal.timeout(5000) }).then((r) =>
		r.text()
	);
	const holder = globalThis as DispatcherHolder;
	originalDispatcher = holder[DISPATCHER];
	const Dispatcher = holder[DISPATCHER]!.constructor;
	(holder as Record<symbol, unknown>)[DISPATCHER] = new Dispatcher({
		headersTimeout: HEADERS_TIMEOUT_MS,
	});
});

afterAll(async () => {
	(globalThis as Record<symbol, unknown>)[DISPATCHER] = originalDispatcher;
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
	received = [];
});

describe('updater transport', () => {
	it('fetch gives up on a slow updater answer at its header deadline (the bug)', async () => {
		const failure = await fetch(new URL('/update', baseUrl), {
			method: 'POST',
			body: '{}',
			signal: AbortSignal.timeout(30_000),
		}).then(
			() => null,
			(err: Error & { cause?: { code?: string } }) => err.cause?.code
		);
		expect(failure).toBe('UND_ERR_HEADERS_TIMEOUT');
	});

	it('waits for an answer slower than that deadline, bounded only by the signal', async () => {
		const response = await requestUpdater(new URL('/update', baseUrl), 'instance-secret', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ composeTemplate: 'services: {}' }),
			signal: AbortSignal.timeout(30_000),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			echo: JSON.stringify({ composeTemplate: 'services: {}' }),
		});
		expect(received).toEqual([
			{
				url: '/update',
				method: 'POST',
				secret: 'instance-secret',
				body: JSON.stringify({ composeTemplate: 'services: {}' }),
			},
		]);
	});

	it('still ends the call when the caller’s signal fires', async () => {
		const started = Date.now();
		await expect(
			requestUpdater(new URL('/update', baseUrl), 'instance-secret', {
				method: 'POST',
				body: '{}',
				signal: AbortSignal.timeout(100),
			})
		).rejects.toMatchObject({ name: 'TimeoutError' });
		expect(Date.now() - started).toBeLessThan(ANSWER_AFTER_MS);
	});
});
