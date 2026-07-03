import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHttpClient } from '../src/utils/fetch';
import {
	OwlatError,
	AuthenticationError,
	NotFoundError,
	ConflictError,
	RateLimitError,
	ValidationError,
	ForbiddenError,
	InvalidStateError,
	LimitReachedError,
} from '../src/errors';

const BASE_URL = 'https://api.test.owlat.app';
const API_KEY = 'lm_test_key';
const DEFAULT_TIMEOUT = 30000;

function createClient() {
	// Disable retries in tests for fast, deterministic behavior
	return createHttpClient(API_KEY, BASE_URL, DEFAULT_TIMEOUT, { maxRetries: 0 });
}

function mockFetch(status: number, body?: unknown, headers: Record<string, string> = {}) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
		const responseHeaders = new Headers(headers);
		const responseBody = body !== undefined ? JSON.stringify(body) : null;
		return new Response(responseBody, { status, headers: responseHeaders });
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('createHttpClient', () => {
	describe('request building', () => {
		it('should send correct method and URL for GET', async () => {
			const spy = mockFetch(200, { data: 'ok' });
			const http = createClient();
			await http.get('/api/v1/contacts');

			expect(spy).toHaveBeenCalledOnce();
			const [url, options] = spy.mock.calls[0];
			expect(url).toBe(`${BASE_URL}/api/v1/contacts`);
			expect(options?.method).toBe('GET');
		});

		it('should send correct method for POST', async () => {
			const spy = mockFetch(200, { data: 'ok' });
			const http = createClient();
			await http.post('/api/v1/contacts', { email: 'a@b.com' });

			const [, options] = spy.mock.calls[0];
			expect(options?.method).toBe('POST');
		});

		it('should send correct method for PUT', async () => {
			const spy = mockFetch(200, { data: 'ok' });
			const http = createClient();
			await http.put('/api/v1/contacts/123', { firstName: 'A' });

			const [, options] = spy.mock.calls[0];
			expect(options?.method).toBe('PUT');
		});

		it('should send correct method for DELETE', async () => {
			const spy = mockFetch(200, { data: 'ok' });
			const http = createClient();
			await http.delete('/api/v1/contacts/123');

			const [, options] = spy.mock.calls[0];
			expect(options?.method).toBe('DELETE');
		});

		it('should send Authorization and Content-Type headers', async () => {
			const spy = mockFetch(200, { data: 'ok' });
			const http = createClient();
			await http.get('/test');

			const [, options] = spy.mock.calls[0];
			const headers = options?.headers as Record<string, string>;
			expect(headers['Authorization']).toBe(`Bearer ${API_KEY}`);
			expect(headers['Content-Type']).toBe('application/json');
		});

		it('should serialize request body as JSON', async () => {
			const spy = mockFetch(200, { data: 'ok' });
			const http = createClient();
			const body = { email: 'a@b.com', firstName: 'Test' };
			await http.post('/test', body);

			const [, options] = spy.mock.calls[0];
			expect(options?.body).toBe(JSON.stringify(body));
		});

		it('should not include body for GET requests', async () => {
			const spy = mockFetch(200, { data: 'ok' });
			const http = createClient();
			await http.get('/test');

			const [, options] = spy.mock.calls[0];
			expect(options?.body).toBeUndefined();
		});
	});

	describe('response parsing', () => {
		it('should parse JSON response and return data + rateLimit', async () => {
			mockFetch(200, { data: { id: '123' } }, {
				'X-RateLimit-Limit': '100',
				'X-RateLimit-Remaining': '99',
				'X-RateLimit-Reset': '1700000000',
			});
			const http = createClient();
			const result = await http.get('/test');

			expect(result.data).toEqual({ data: { id: '123' } });
			expect(result.rateLimit).toEqual({
				limit: 100,
				remaining: 99,
				reset: 1700000000,
			});
		});

		it('should use default rate limit values when headers are missing', async () => {
			mockFetch(200, { data: 'ok' });
			const http = createClient();
			const result = await http.get('/test');

			expect(result.rateLimit).toEqual({
				limit: 10,
				remaining: 10,
				reset: 0,
			});
		});

		it('should handle 204 No Content', async () => {
			mockFetch(204);
			const http = createClient();
			const result = await http.delete('/test');

			expect(result.data).toBeUndefined();
		});

		it('should handle content-length: 0', async () => {
			mockFetch(200, undefined, { 'content-length': '0' });
			const http = createClient();
			const result = await http.get('/test');

			expect(result.data).toBeUndefined();
		});

		it('should throw parse_error for unparseable response body', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue(
				new Response('not json', { status: 200 })
			);
			const http = createClient();

			await expect(http.get('/test')).rejects.toThrow(OwlatError);
			await expect(http.get('/test')).rejects.toMatchObject({
				code: 'parse_error',
				statusCode: 200,
			});
		});

		it('should throw parse_error when a 2xx body is a scalar, not an object', async () => {
			// Valid JSON, but the wrong shape — the contract drifted.
			mockFetch(200, 'just a string');
			const http = createClient();

			await expect(http.get('/test')).rejects.toMatchObject({
				code: 'parse_error',
				statusCode: 200,
			});
		});

		it('should throw parse_error when a 2xx body is null', async () => {
			mockFetch(200, null);
			const http = createClient();

			await expect(http.get('/test')).rejects.toMatchObject({ code: 'parse_error' });
		});
	});

	describe('error mapping by status code', () => {
		const errorBody = { error: { message: 'Something went wrong', category: 'invalid_input' } };

		it('should throw ValidationError for 400 and surface the category on .code', async () => {
			mockFetch(400, errorBody);
			const http = createClient();

			await expect(http.post('/test')).rejects.toThrow(ValidationError);
			await expect(http.post('/test')).rejects.toMatchObject({
				message: 'Something went wrong',
				code: 'invalid_input',
				statusCode: 400,
			});
		});

		it('should surface error.data on the thrown error', async () => {
			mockFetch(400, {
				error: { message: 'Bad field', category: 'invalid_input', data: { field: 'email' } },
			});
			const http = createClient();

			await expect(http.post('/test')).rejects.toMatchObject({
				code: 'invalid_input',
				data: { field: 'email' },
			});
		});

		it('should throw AuthenticationError for 401', async () => {
			mockFetch(401, errorBody);
			const http = createClient();

			await expect(http.get('/test')).rejects.toThrow(AuthenticationError);
			await expect(http.get('/test')).rejects.toMatchObject({
				statusCode: 401,
			});
		});

		it('should throw NotFoundError for 404', async () => {
			mockFetch(404, errorBody);
			const http = createClient();

			await expect(http.get('/test')).rejects.toThrow(NotFoundError);
			await expect(http.get('/test')).rejects.toMatchObject({
				statusCode: 404,
			});
		});

		it('should throw ConflictError for 409', async () => {
			mockFetch(409, errorBody);
			const http = createClient();

			await expect(http.post('/test')).rejects.toThrow(ConflictError);
			await expect(http.post('/test')).rejects.toMatchObject({
				statusCode: 409,
			});
		});

		it('should throw ForbiddenError for 403 and surface the category on .code', async () => {
			mockFetch(403, { error: { message: 'Account suspended', category: 'forbidden' } });
			const http = createClient();

			await expect(http.post('/test')).rejects.toThrow(ForbiddenError);
			await expect(http.post('/test')).rejects.toMatchObject({
				message: 'Account suspended',
				code: 'forbidden',
				statusCode: 403,
			});
		});

		it('should throw InvalidStateError for 422 (e.g. unverified sending domain)', async () => {
			mockFetch(422, {
				error: {
					message: 'Sending domain is not verified.',
					category: 'invalid_state',
					data: { reason: 'domain_unverified' },
				},
			});
			const http = createClient();

			await expect(http.post('/test')).rejects.toThrow(InvalidStateError);
			await expect(http.post('/test')).rejects.toMatchObject({
				message: 'Sending domain is not verified.',
				code: 'invalid_state',
				statusCode: 422,
				data: { reason: 'domain_unverified' },
			});
		});

		it('should throw LimitReachedError for 402', async () => {
			mockFetch(402, { error: { message: 'Plan limit reached', category: 'limit_reached' } });
			const http = createClient();

			await expect(http.post('/test')).rejects.toThrow(LimitReachedError);
			await expect(http.post('/test')).rejects.toMatchObject({
				message: 'Plan limit reached',
				code: 'limit_reached',
				statusCode: 402,
			});
		});

		it('should throw RateLimitError for 429 with Retry-After header', async () => {
			mockFetch(429, errorBody, { 'Retry-After': '30' });
			const http = createClient();

			try {
				await http.get('/test');
				expect.fail('should have thrown');
			} catch (err) {
				expect(err).toBeInstanceOf(RateLimitError);
				const rateLimitErr = err as RateLimitError;
				expect(rateLimitErr.statusCode).toBe(429);
				expect(rateLimitErr.code).toBe('rate_limited');
				expect(rateLimitErr.retryAfter).toBe(30);
			}
		});

		it('should default retryAfter to 1 when Retry-After header is missing', async () => {
			mockFetch(429, errorBody);
			const http = createClient();

			try {
				await http.get('/test');
				expect.fail('should have thrown');
			} catch (err) {
				const rateLimitErr = err as RateLimitError;
				expect(rateLimitErr.retryAfter).toBe(1);
			}
		});

		it('should prefer data.retryAfter over the Retry-After header', async () => {
			mockFetch(
				429,
				{ error: { message: 'Slow down', category: 'rate_limited', data: { retryAfter: 45 } } },
				{ 'Retry-After': '30' },
			);
			const http = createClient();

			try {
				await http.get('/test');
				expect.fail('should have thrown');
			} catch (err) {
				const rateLimitErr = err as RateLimitError;
				expect(rateLimitErr.retryAfter).toBe(45);
			}
		});

		it('should throw generic OwlatError for 500', async () => {
			mockFetch(500, errorBody);
			const http = createClient();

			await expect(http.get('/test')).rejects.toThrow(OwlatError);
			await expect(http.get('/test')).rejects.toMatchObject({
				statusCode: 500,
			});
		});

		it('should use fallback message/category when error body is missing fields', async () => {
			mockFetch(500, { error: {} });
			const http = createClient();

			await expect(http.get('/test')).rejects.toMatchObject({
				message: 'Unknown error',
				code: 'internal',
			});
		});
	});

	describe('network and timeout errors', () => {
		it('should throw timeout error on AbortError', async () => {
			const abortError = new DOMException('The operation was aborted', 'AbortError');
			vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError);
			const http = createClient();

			await expect(http.get('/test')).rejects.toThrow(OwlatError);
			await expect(http.get('/test')).rejects.toMatchObject({
				code: 'timeout',
				statusCode: 0,
			});
		});

		it('should throw network_error on fetch failure', async () => {
			vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
			const http = createClient();

			await expect(http.get('/test')).rejects.toThrow(OwlatError);
			await expect(http.get('/test')).rejects.toMatchObject({
				code: 'network_error',
				statusCode: 0,
			});
		});

		it('should include error message in network_error', async () => {
			vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('DNS lookup failed'));
			const http = createClient();

			await expect(http.get('/test')).rejects.toMatchObject({
				message: 'Network error: DNS lookup failed',
			});
		});

		it('should pass AbortSignal to fetch', async () => {
			const spy = mockFetch(200, { data: 'ok' });
			const http = createClient();
			await http.get('/test');

			const [, options] = spy.mock.calls[0];
			expect(options?.signal).toBeInstanceOf(AbortSignal);
		});

		it('should use custom timeout when provided', async () => {
			const spy = mockFetch(200, { data: 'ok' });
			const http = createClient();
			await http.get('/test', 5000);

			// Verify fetch was called (timeout is internal via AbortController)
			expect(spy).toHaveBeenCalledOnce();
		});
	});

	describe('rate limit extraction', () => {
		it('should extract all rate limit headers', async () => {
			mockFetch(200, { ok: true }, {
				'X-RateLimit-Limit': '50',
				'X-RateLimit-Remaining': '42',
				'X-RateLimit-Reset': '1700001000',
			});
			const http = createClient();
			const result = await http.get('/test');

			expect(result.rateLimit).toEqual({
				limit: 50,
				remaining: 42,
				reset: 1700001000,
			});
		});

		it('should include rate limit on error responses', async () => {
			mockFetch(404, { error: { message: 'Not found', category: 'not_found' } }, {
				'X-RateLimit-Limit': '100',
				'X-RateLimit-Remaining': '98',
				'X-RateLimit-Reset': '1700000000',
			});
			const http = createClient();

			try {
				await http.get('/test');
				expect.fail('should have thrown');
			} catch (err) {
				const error = err as NotFoundError;
				expect(error.rateLimit).toEqual({
					limit: 100,
					remaining: 98,
					reset: 1700000000,
				});
			}
		});
	});

	describe('retry idempotency (no duplicate POST sends)', () => {
		// Retry client with zero backoff for fast, deterministic tests.
		function createRetryClient() {
			return createHttpClient(API_KEY, BASE_URL, DEFAULT_TIMEOUT, {
				maxRetries: 2,
				initialDelayMs: 0,
			});
		}

		/** Queue of responses returned in order across successive fetch calls. */
		function mockSequence(responses: Array<{ status: number; body?: unknown }>) {
			let call = 0;
			return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
				const r = responses[Math.min(call, responses.length - 1)];
				call++;
				return new Response(
					r.body !== undefined ? JSON.stringify(r.body) : null,
					{ status: r.status, headers: new Headers() },
				);
			});
		}

		it('should NOT retry POST on 5xx (would duplicate a send)', async () => {
			const spy = mockSequence([
				{ status: 502, body: { error: { message: 'Bad gateway', category: 'internal' } } },
				{ status: 200, body: { data: 'ok' } },
			]);
			const http = createRetryClient();

			await expect(http.post('/test')).rejects.toThrow(OwlatError);
			// Exactly one attempt — the 502 surfaces immediately, no replay.
			expect(spy).toHaveBeenCalledOnce();
		});

		it('should NOT retry POST on network error (server may have processed it)', async () => {
			const spy = vi
				.spyOn(globalThis, 'fetch')
				.mockRejectedValue(new TypeError('Failed to fetch'));
			const http = createRetryClient();

			await expect(http.post('/test')).rejects.toMatchObject({ code: 'network_error' });
			expect(spy).toHaveBeenCalledOnce();
		});

		it('SHOULD retry GET on 5xx (idempotent) and succeed', async () => {
			const spy = mockSequence([
				{ status: 503, body: { error: { message: 'Unavailable', category: 'internal' } } },
				{ status: 200, body: { data: 'ok' } },
			]);
			const http = createRetryClient();

			const result = await http.get('/test');
			expect(result.data).toEqual({ data: 'ok' });
			expect(spy).toHaveBeenCalledTimes(2);
		});

		it('SHOULD retry PUT and DELETE on 5xx (idempotent)', async () => {
			const putSpy = mockSequence([
				{ status: 500, body: { error: { message: 'oops', category: 'internal' } } },
				{ status: 200, body: { data: 'ok' } },
			]);
			const http = createRetryClient();
			await http.put('/test', { a: 1 });
			expect(putSpy).toHaveBeenCalledTimes(2);

			vi.restoreAllMocks();

			const delSpy = mockSequence([
				{ status: 500, body: { error: { message: 'oops', category: 'internal' } } },
				{ status: 204 },
			]);
			const http2 = createRetryClient();
			await http2.delete('/test');
			expect(delSpy).toHaveBeenCalledTimes(2);
		});

		it('SHOULD retry POST on 429 (pre-processing rejection, safe to replay)', async () => {
			const spy = mockSequence([
				{ status: 429, body: { error: { message: 'Slow down', category: 'rate_limited' } } },
				{ status: 200, body: { data: 'ok' } },
			]);
			const http = createRetryClient();

			const result = await http.post('/test', { a: 1 });
			expect(result.data).toEqual({ data: 'ok' });
			expect(spy).toHaveBeenCalledTimes(2);
		});
	});

	describe('empty-body error responses (regression)', () => {
		// A 4xx/5xx with an empty body (gateway 502/503/504, edge 429, proxy 401)
		// must surface the typed error — and retry the retryable ones — instead
		// of being short-circuited by the "empty response" branch into a null
		// "success" the resource layer then dereferences. Each call returns a
		// fresh Response so the body can be re-read across retries.
		function mockEmptyBody(status: number, headers: Record<string, string> = {}) {
			return vi.spyOn(globalThis, 'fetch').mockImplementation(
				async () => new Response(null, { status, headers: new Headers(headers) }),
			);
		}

		function retryClient() {
			return createHttpClient(API_KEY, BASE_URL, DEFAULT_TIMEOUT, {
				maxRetries: 2,
				initialDelayMs: 0,
			});
		}

		it('throws a typed 503 error (not null) on an empty body and retries the idempotent GET', async () => {
			const spy = mockEmptyBody(503);
			const http = retryClient();

			await expect(http.get('/test')).rejects.toMatchObject({
				code: 'internal',
				statusCode: 503,
			});
			// idempotent GET + 5xx → maxRetries + 1 attempts
			expect(spy).toHaveBeenCalledTimes(3);
		});

		it('throws RateLimitError (not null) on an empty-body 429 and retries', async () => {
			const spy = mockEmptyBody(429);
			const http = retryClient();

			await expect(http.get('/test')).rejects.toBeInstanceOf(RateLimitError);
			expect(spy).toHaveBeenCalledTimes(3);
		});

		it('throws AuthenticationError (not null) on an empty-body 401 with Content-Length: 0, no retry', async () => {
			const spy = mockEmptyBody(401, { 'content-length': '0' });
			const http = retryClient();

			await expect(http.get('/test')).rejects.toBeInstanceOf(AuthenticationError);
			// 401 is not retryable — exactly one attempt.
			expect(spy).toHaveBeenCalledOnce();
		});

		it('still returns undefined data for an empty-body 204 success', async () => {
			mockEmptyBody(204);
			const http = createClient();
			const result = await http.delete('/test');

			expect(result.data).toBeUndefined();
		});
	});
});
