import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHttpClient } from '../src/utils/fetch';
import { OwlatError } from '../src/errors';

// The request timeout must cover the body as well as the headers: `fetch()`
// resolves once the headers arrive, and a body that then stalls used to leave
// the call pending forever (or, if it eventually arrived, succeed long after
// the configured deadline).

const BASE_URL = 'https://api.test.owlat.app';
const API_KEY = 'lm_test_key';
const TIMEOUT_MS = 20;

afterEach(() => {
	vi.restoreAllMocks();
});

/** A body stream that delivers `text` after `delayMs`, or never when null. */
function slowBody(text: string, delayMs: number | null): ReadableStream<Uint8Array> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return new ReadableStream<Uint8Array>({
		start(controller) {
			if (delayMs === null) return;
			timer = setTimeout(() => {
				controller.enqueue(new TextEncoder().encode(text));
				controller.close();
			}, delayMs);
		},
		// The client cancels the stream when the deadline cuts the read off; a
		// late enqueue into the closed controller would surface as an unhandled error.
		cancel() {
			clearTimeout(timer);
		},
	});
}

/** Headers arrive immediately; the body follows per `slowBody`. */
function mockHeadersThenBody(status: number, text: string, delayMs: number | null) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(
		async () =>
			new Response(slowBody(text, delayMs), {
				status,
				headers: { 'Content-Type': 'application/json' },
			})
	);
}

function client(maxRetries = 0) {
	return createHttpClient(API_KEY, BASE_URL, TIMEOUT_MS, { maxRetries, initialDelayMs: 0 });
}

const OK_BODY = JSON.stringify({ id: 'x' });
const ERROR_BODY = JSON.stringify({ error: { message: 'boom', category: 'internal' } });

describe('request deadline covers the response body', () => {
	it('times out a success body that arrives after the deadline', async () => {
		mockHeadersThenBody(200, OK_BODY, 120);

		const started = Date.now();
		await expect(client().get('/test')).rejects.toMatchObject({
			code: 'timeout',
			statusCode: 0,
			message: `Request timed out after ${TIMEOUT_MS}ms`,
		});
		// Rejected at the deadline, not when the late body finally landed.
		expect(Date.now() - started).toBeLessThan(110);
	});

	it('times out a success body that never arrives', async () => {
		mockHeadersThenBody(200, OK_BODY, null);
		await expect(client().get('/test')).rejects.toMatchObject({ code: 'timeout' });
	});

	it('times out a stalled error body instead of hanging', async () => {
		mockHeadersThenBody(500, ERROR_BODY, null);
		await expect(client().get('/test')).rejects.toMatchObject({ code: 'timeout' });
	});

	it('times out a delayed error body', async () => {
		mockHeadersThenBody(404, ERROR_BODY, 120);
		await expect(client().get('/test')).rejects.toMatchObject({ code: 'timeout' });
	});

	it('aborts the request signal when the body deadline passes', async () => {
		const spy = mockHeadersThenBody(200, OK_BODY, null);
		await expect(client().get('/test')).rejects.toThrow(OwlatError);
		expect(spy.mock.calls[0][1]?.signal?.aborted).toBe(true);
	});

	it('still succeeds when the body arrives inside the deadline', async () => {
		const spy = mockHeadersThenBody(200, OK_BODY, 1);
		const http = createHttpClient(API_KEY, BASE_URL, 500, { maxRetries: 0 });

		await expect(http.get('/test')).resolves.toMatchObject({ data: { id: 'x' } });
		// The timer is cleared once the body is in: it must not fire later.
		await new Promise((r) => setTimeout(r, 600));
		expect(spy.mock.calls[0][1]?.signal?.aborted).toBe(false);
	});

	it('classifies a body stream that errors as a network error', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.error(new TypeError('socket hang up'));
						},
					}),
					{ status: 200 }
				)
		);

		await expect(client().get('/test')).rejects.toMatchObject({
			code: 'network_error',
			message: 'Network error: socket hang up',
		});
	});

	it('still reports a malformed body as a parse error, not a transport fault', async () => {
		mockHeadersThenBody(200, '{not json', 1);
		const http = createHttpClient(API_KEY, BASE_URL, 500, { maxRetries: 0 });
		await expect(http.get('/test')).rejects.toMatchObject({ code: 'parse_error' });
	});
});

describe('body deadline keeps the no-replay rule for POST', () => {
	it('does not replay a transactional POST whose success body stalled', async () => {
		const spy = mockHeadersThenBody(200, OK_BODY, null);

		await expect(
			client(2).post('/api/v1/transactional', { transactionalId: 't', email: 'a@example.com' })
		).rejects.toMatchObject({ code: 'timeout' });
		// The server answered with headers, so it received the send: one attempt only.
		expect(spy).toHaveBeenCalledOnce();
	});

	it('does not replay a POST whose 5xx error body stalled', async () => {
		const spy = mockHeadersThenBody(503, ERROR_BODY, null);
		await expect(client(2).post('/api/v1/events')).rejects.toMatchObject({ code: 'timeout' });
		expect(spy).toHaveBeenCalledOnce();
	});

	it('does not replay a POST whose body stream failed', async () => {
		const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.error(new TypeError('socket hang up'));
						},
					}),
					{ status: 200 }
				)
		);
		await expect(client(2).post('/api/v1/transactional')).rejects.toMatchObject({
			code: 'network_error',
		});
		expect(spy).toHaveBeenCalledOnce();
	});

	it('retries an idempotent GET whose body stalled, then succeeds', async () => {
		let call = 0;
		const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			call++;
			return new Response(slowBody(OK_BODY, call === 1 ? null : 1), { status: 200 });
		});

		await expect(client(2).get('/test')).resolves.toMatchObject({ data: { id: 'x' } });
		expect(spy).toHaveBeenCalledTimes(2);
	});
});

describe('body deadline releases the connection', () => {
	it('cancels the body stream when the deadline cuts the read off', async () => {
		const cancel = vi.fn();
		vi.spyOn(globalThis, 'fetch').mockImplementation(
			async () =>
				new Response(new ReadableStream<Uint8Array>({ cancel }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				})
		);

		await expect(client().get('/test')).rejects.toMatchObject({ code: 'timeout' });
		// A runtime that does not tear the stream down on abort would otherwise
		// keep the connection open for a body nobody reads.
		await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
	});

	it('does not cancel a body that arrived in time', async () => {
		const cancel = vi.fn();
		vi.spyOn(globalThis, 'fetch').mockImplementation(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(OK_BODY));
							controller.close();
						},
						cancel,
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				)
		);

		await expect(client().get('/test')).resolves.toMatchObject({ data: { id: 'x' } });
		expect(cancel).not.toHaveBeenCalled();
	});
});

describe('body deadline edge cases', () => {
	it('cancels the body without reading when the deadline passed before the headers landed', async () => {
		const cancel = vi.fn();
		// A runtime that ignores the abort and hands back headers after the deadline.
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS * 3));
			return new Response(new ReadableStream<Uint8Array>({ cancel }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});

		await expect(client().get('/test')).rejects.toMatchObject({ code: 'timeout' });
		await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
	});

	/** A response object with no body stream, as some polyfills produce. */
	function streamlessResponse(text: () => Promise<string>): Response {
		return {
			ok: true,
			status: 200,
			headers: new Headers({ 'Content-Type': 'application/json' }),
			body: null,
			text,
		} as unknown as Response;
	}

	it('times out a stream-less response whose text() is late', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
			streamlessResponse(() => new Promise((resolve) => setTimeout(() => resolve(OK_BODY), 120)))
		);
		await expect(client().get('/test')).rejects.toMatchObject({ code: 'timeout' });
	});

	it('times out a stream-less response that arrives after the deadline', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS * 3));
			return streamlessResponse(async () => OK_BODY);
		});
		await expect(client().get('/test')).rejects.toMatchObject({ code: 'timeout' });
	});

	it('reads a stream-less response that answers in time', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
			streamlessResponse(async () => OK_BODY)
		);
		await expect(client().get('/test')).resolves.toMatchObject({ data: { id: 'x' } });
	});

	it('falls back to a generic error for a non-JSON error body', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(
			async () => new Response('<html>Bad Gateway</html>', { status: 400 })
		);
		await expect(client().get('/test')).rejects.toMatchObject({
			message: 'Unknown error',
			statusCode: 400,
		});
	});
});
