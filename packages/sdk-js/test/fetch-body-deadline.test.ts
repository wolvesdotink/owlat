import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createHttpClient } from '../src/utils/fetch';
import { OwlatError } from '../src/errors';

// The request timeout must cover the body as well as the headers: `fetch()`
// resolves once the headers arrive, and a body that then stalls used to leave
// the call pending forever (or, if it eventually arrived, succeed long after
// the configured deadline).
//
// Every case runs on fake timers and hand-released bodies, so the test reads
// the order of events (deadline, headers, body) rather than a runner's clock.

const BASE_URL = 'https://api.test.owlat.app';
const API_KEY = 'lm_test_key';
const TIMEOUT_MS = 20;

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/**
 * A body stream that delivers nothing until the test calls `deliver`. A
 * delivery after the client cancelled the stream is dropped, as a runtime
 * would drop bytes for a torn-down connection.
 */
function heldBody() {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let cancelled = false;
	const cancel = vi.fn(() => {
		cancelled = true;
	});
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
		cancel,
	});
	return {
		stream,
		cancel,
		deliver(text: string) {
			if (cancelled) return;
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	};
}

/** A body stream that is complete before the client starts reading. */
function readyBody(text: string): ReadableStream<Uint8Array> {
	const body = heldBody();
	body.deliver(text);
	return body.stream;
}

/** A promise the test settles by hand. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Headers arrive immediately; the body is whatever `body` delivers. */
function mockHeadersThenBody(status: number, body: ReturnType<typeof heldBody>) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(
		async () =>
			new Response(body.stream, {
				status,
				headers: { 'Content-Type': 'application/json' },
			})
	);
}

/** Observe a call's outcome without awaiting it, so time can be advanced first. */
function track<T>(promise: Promise<T>) {
	const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
	promise.then(
		(value) => {
			state.settled = true;
			state.value = value;
		},
		(error: unknown) => {
			state.settled = true;
			state.error = error;
		}
	);
	return state;
}

function client(maxRetries = 0) {
	return createHttpClient(API_KEY, BASE_URL, TIMEOUT_MS, { maxRetries, initialDelayMs: 0 });
}

const OK_BODY = JSON.stringify({ id: 'x' });
const ERROR_BODY = JSON.stringify({ error: { message: 'boom', category: 'internal' } });

describe('request deadline covers the response body', () => {
	it('times out a success body that arrives after the deadline', async () => {
		const body = heldBody();
		mockHeadersThenBody(200, body);

		const call = track(client().get('/test'));
		await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
		expect(call.settled).toBe(false);
		// Rejected at the deadline, not when the late body lands afterwards.
		await vi.advanceTimersByTimeAsync(1);
		expect(call.error).toMatchObject({
			code: 'timeout',
			statusCode: 0,
			message: `Request timed out after ${TIMEOUT_MS}ms`,
		});
		body.deliver(OK_BODY);
		await vi.advanceTimersByTimeAsync(100);
		expect(call.value).toBeUndefined();
	});

	it('times out a success body that never arrives', async () => {
		mockHeadersThenBody(200, heldBody());
		const call = track(client().get('/test'));
		await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
		expect(call.error).toMatchObject({ code: 'timeout' });
	});

	it('times out a stalled error body instead of hanging', async () => {
		mockHeadersThenBody(500, heldBody());
		const call = track(client().get('/test'));
		await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
		expect(call.error).toMatchObject({ code: 'timeout' });
	});

	it('times out a delayed error body', async () => {
		const body = heldBody();
		mockHeadersThenBody(404, body);
		const call = track(client().get('/test'));
		await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
		expect(call.error).toMatchObject({ code: 'timeout' });
		body.deliver(ERROR_BODY);
		await vi.advanceTimersByTimeAsync(100);
		expect(call.error).toMatchObject({ code: 'timeout' });
	});

	it('aborts the request signal when the body deadline passes', async () => {
		const spy = mockHeadersThenBody(200, heldBody());
		const call = track(client().get('/test'));
		await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
		expect(call.error).toBeInstanceOf(OwlatError);
		expect(spy.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
	});

	it('still succeeds when the body arrives inside the deadline', async () => {
		const body = heldBody();
		const spy = mockHeadersThenBody(200, body);
		const http = createHttpClient(API_KEY, BASE_URL, 500, { maxRetries: 0 });

		const call = http.get('/test');
		await vi.advanceTimersByTimeAsync(1);
		body.deliver(OK_BODY);
		await expect(call).resolves.toMatchObject({ data: { id: 'x' } });
		// The timer is cleared once the body is in: it must not fire later.
		await vi.advanceTimersByTimeAsync(600);
		expect(spy.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
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
		const body = heldBody();
		mockHeadersThenBody(200, body);
		const http = createHttpClient(API_KEY, BASE_URL, 500, { maxRetries: 0 });
		const call = http.get('/test');
		body.deliver('{not json');
		await expect(call).rejects.toMatchObject({ code: 'parse_error' });
	});
});

describe('body deadline keeps the no-replay rule for POST', () => {
	it('does not replay a transactional POST whose success body stalled', async () => {
		const spy = mockHeadersThenBody(200, heldBody());

		const call = track(
			client(2).post('/api/v1/transactional', { transactionalId: 't', email: 'a@example.com' })
		);
		await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 10);
		expect(call.error).toMatchObject({ code: 'timeout' });
		// The server answered with headers, so it received the send: one attempt only.
		expect(spy).toHaveBeenCalledOnce();
	});

	it('does not replay a POST whose 5xx error body stalled', async () => {
		const spy = mockHeadersThenBody(503, heldBody());
		const call = track(client(2).post('/api/v1/events'));
		await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 10);
		expect(call.error).toMatchObject({ code: 'timeout' });
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
			return new Response(call === 1 ? heldBody().stream : readyBody(OK_BODY), { status: 200 });
		});

		const backoffMs = 5;
		const http = createHttpClient(API_KEY, BASE_URL, TIMEOUT_MS, {
			maxRetries: 2,
			initialDelayMs: backoffMs,
		});

		const result = track(http.get('/test'));
		await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
		// The first attempt timed out at the deadline and now waits out its backoff.
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(backoffMs - 1);
		expect(spy).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(result.value).toMatchObject({ data: { id: 'x' } });
		expect(spy).toHaveBeenCalledTimes(2);
	});
});

describe('body deadline releases the connection', () => {
	it('cancels the body stream when the deadline cuts the read off', async () => {
		const body = heldBody();
		mockHeadersThenBody(200, body);

		const call = track(client().get('/test'));
		await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
		expect(call.error).toMatchObject({ code: 'timeout' });
		// A runtime that does not tear the stream down on abort would otherwise
		// keep the connection open for a body nobody reads.
		expect(body.cancel).toHaveBeenCalledOnce();
	});

	it('does not cancel a body that arrived in time', async () => {
		const body = heldBody();
		body.deliver(OK_BODY);
		mockHeadersThenBody(200, body);

		await expect(client().get('/test')).resolves.toMatchObject({ data: { id: 'x' } });
		expect(body.cancel).not.toHaveBeenCalled();
	});
});

describe('body deadline edge cases', () => {
	it('cancels the body without reading when the deadline passed before the headers landed', async () => {
		const body = heldBody();
		const headers = deferred<void>();
		// A runtime that ignores the abort and hands back headers after the deadline.
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			await headers.promise;
			return new Response(body.stream, {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});

		const call = track(client().get('/test'));
		await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
		expect(call.settled).toBe(false);
		headers.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(call.error).toMatchObject({ code: 'timeout' });
		expect(body.cancel).toHaveBeenCalledOnce();
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
		const text = deferred<string>();
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
			streamlessResponse(() => text.promise)
		);
		const call = track(client().get('/test'));
		await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
		expect(call.error).toMatchObject({ code: 'timeout' });
		text.resolve(OK_BODY);
		await vi.advanceTimersByTimeAsync(0);
		expect(call.value).toBeUndefined();
	});

	it('times out a stream-less response that arrives after the deadline', async () => {
		const headers = deferred<void>();
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			await headers.promise;
			return streamlessResponse(async () => OK_BODY);
		});
		const call = track(client().get('/test'));
		await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
		expect(call.settled).toBe(false);
		headers.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(call.error).toMatchObject({ code: 'timeout' });
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
