/**
 * The shared Mandrill HTTP client: base URL, error-body reading, timeout and
 * key redaction, for both the send adapter and the sender-domain client.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAmbiguousPostDispatchTimeout } from '../../errors';
import { MANDRILL_API_BASE, postMandrill } from '../client';

const KEY = 'md-client-secret';
const OPTIONS = {
	timeoutMs: 1_000,
	timeoutMessage: 'Mandrill test call timed out',
	failureLabel: 'Mandrill test call failed',
};

let fetchMock: ReturnType<typeof vi.fn>;

/** The error a call rejects with; a call that resolves fails the test. */
function rejectionOf(call: Promise<unknown>): Promise<Error> {
	return call.then(
		() => {
			throw new Error('expected postMandrill to reject');
		},
		(e: unknown) => e as Error
	);
}

beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('postMandrill request', () => {
	it('posts JSON with the key in the body to the one base URL', async () => {
		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));

		const result = await postMandrill(
			'/senders/check-domain',
			{ key: KEY, domain: 'a.com' },
			OPTIONS
		);

		expect(result).toEqual({ ok: true, payload: { ok: 1 } });
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${MANDRILL_API_BASE}/senders/check-domain`);
		expect(url).not.toContain(KEY);
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body as string)).toEqual({ key: KEY, domain: 'a.com' });
	});
});

describe('postMandrill failure bodies', () => {
	it('redacts the key from a structured error message that echoes it', async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({ status: 'error', name: 'ValidationError', message: `bad key=${KEY}` }),
				{ status: 400, headers: { 'Retry-After': '7' } }
			)
		);

		const result = await postMandrill('/messages/send-raw', { key: KEY }, OPTIONS);

		expect(result).toEqual({
			ok: false,
			status: 400,
			retryAfter: '7',
			error: {
				surfaced: 'ValidationError: bad key=[redacted]',
				classifyText: 'ValidationError: bad key=[redacted]',
			},
		});
	});

	it('surfaces an unstructured body by status and label alone', async () => {
		// A gateway that echoes the request: the body IS our key-bearing payload.
		fetchMock.mockImplementationOnce(
			async (_url: string, init: RequestInit) => new Response(init.body as string, { status: 502 })
		);

		const result = await postMandrill('/messages/send-raw', { key: KEY }, OPTIONS);

		expect(JSON.stringify(result)).not.toContain(KEY);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.surfaced).toBe('Mandrill test call failed (HTTP 502)');
			expect(result.retryAfter).toBeNull();
		}
	});
});

describe('postMandrill thrown errors', () => {
	it('redacts the key from a thrown message and keeps the error name', async () => {
		const thrown = new TypeError(`fetch failed for key ${KEY}`);
		fetchMock.mockRejectedValueOnce(thrown);

		const error = await postMandrill('/messages/send-raw', { key: KEY }, OPTIONS).catch(
			(e: unknown) => e
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe('fetch failed for key [redacted]');
		expect((error as Error).name).toBe('TypeError');
		expect((error as Error).cause).toBeUndefined();
	});

	it('redacts the key from a JSON parse error on a 200 body that echoed the request', async () => {
		fetchMock.mockImplementationOnce(
			async (_url: string, init: RequestInit) =>
				new Response(`not json ${init.body as string}`, { status: 200 })
		);

		const error = await rejectionOf(postMandrill('/messages/send-raw', { key: KEY }, OPTIONS));

		expect(error).toBeInstanceOf(Error);
		expect(error.message).not.toContain(KEY);
	});

	it('still reports the timeout sentinel, which the ambiguity check recognises', async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
			signal = init.signal ?? undefined;
			return new Promise(() => {});
		});

		const pending = rejectionOf(postMandrill('/messages/send-raw', { key: KEY }, OPTIONS));
		await vi.advanceTimersByTimeAsync(OPTIONS.timeoutMs);
		const error = await pending;

		expect(error.message).toBe(OPTIONS.timeoutMessage);
		expect(isAmbiguousPostDispatchTimeout(error.name, error.message, OPTIONS.timeoutMessage)).toBe(
			true
		);
		// The losing fetch is aborted rather than left running.
		expect(signal?.aborted).toBe(true);
	});

	it('keeps a runtime TimeoutError name through the rethrow', async () => {
		const timeout = new Error('The operation was aborted due to timeout');
		timeout.name = 'TimeoutError';
		fetchMock.mockRejectedValueOnce(timeout);

		const error = await rejectionOf(postMandrill('/messages/send-raw', { key: KEY }, OPTIONS));

		expect(error.name).toBe('TimeoutError');
	});
});
