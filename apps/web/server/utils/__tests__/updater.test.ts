// @vitest-environment node
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { requestUpdater } from '../updater';

/**
 * The updater transport against a fake updater that answers late.
 *
 * Node's fetch (undici) fails a response whose headers take longer than its
 * `headersTimeout` (300 s by default), whatever AbortSignal the caller passes,
 * so `/update` and `/apply-profiles` were cut off at five minutes although the
 * routes allow 30 and 10. Waiting five real minutes is not an option here, so
 * the fetch case runs undici's fetch with an `Agent` whose `headersTimeout` is
 * 200 ms and lets the fake updater answer after 2.5 s: the same race at a
 * smaller scale. (undici checks its header deadline on a coarse timer that
 * ticks about once a second, so the answer has to come well after one tick.)
 *
 * The short deadline goes to that one call as its `dispatcher`, from the npm
 * `undici` package, and Node's global dispatcher is left alone. Its class is
 * not something to construct: Node 26 keeps a compatibility wrapper there
 * whose constructor wants a dispatcher, not options.
 */

const HEADERS_TIMEOUT_MS = 200;
const ANSWER_AFTER_MS = 2500;

let server: Server;
let baseUrl: URL;
let received: { url?: string; method?: string; secret?: string; body: string }[] = [];
let shortHeaderDeadline: Agent;
/** Called once the fake updater has read a request it is going to answer late. */
let onRequest: (() => void) | undefined;

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
		// Only the calls under test reach the fake updater. Anything else that
		// finds the port (a host process probing listening ports sends `GET /`)
		// gets a 404 and is neither recorded nor taken for the awaited request.
		if (req.method !== 'POST' || req.url !== '/update') {
			res.writeHead(404).end();
			return;
		}
		received.push({
			url: req.url,
			method: req.method,
			secret: req.headers['x-instance-secret'] as string | undefined,
			body,
		});
		onRequest?.();
		onRequest = undefined;
		setTimeout(() => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ success: true, echo: body }));
		}, ANSWER_AFTER_MS);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
	shortHeaderDeadline = new Agent({ headersTimeout: HEADERS_TIMEOUT_MS });
});

afterAll(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await shortHeaderDeadline.close();
});

afterEach(() => {
	received = [];
});

describe('updater transport', () => {
	it('fetch gives up on a slow updater answer at its header deadline (the bug)', async () => {
		const failure = await undiciFetch(new URL('/update', baseUrl), {
			method: 'POST',
			body: '{}',
			signal: AbortSignal.timeout(30_000),
			dispatcher: shortHeaderDeadline,
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
		const caller = new AbortController();
		const arrived = new Promise<void>((resolve) => (onRequest = resolve));
		const call = requestUpdater(new URL('/update', baseUrl), 'instance-secret', {
			method: 'POST',
			body: '{}',
			signal: caller.signal,
		});
		const rejected = expect(call).rejects.toMatchObject({ name: 'TimeoutError' });
		// The updater has the request and is still working on its answer.
		await arrived;
		caller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
		await rejected;
	});
});
