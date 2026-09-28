/**
 * `fetchProviderPage` — the one place an integration import adapter's HTTP
 * failure is classified as retryable or fatal.
 *
 * Stubs `global.fetch`. The walker retries a `RetryableProviderError` up to
 * `MAX_RETRIES` and fails the import on any other `Error`, so the class of
 * the thrown error is the contract under test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	fetchProviderPage,
	RetryableProviderError,
	type FetchProviderPageOptions,
} from '../_common';

type Body = { message?: string };

const OPTIONS: FetchProviderPageOptions<Body> = {
	label: 'Acme',
	where: 'at offset 200',
	extractMessage: (body) => body.message,
};

function stubFetch(response: Response | Error): void {
	global.fetch =
		response instanceof Error
			? vi.fn().mockRejectedValue(response)
			: vi.fn().mockResolvedValue(response);
}

async function thrown(options: FetchProviderPageOptions<Body> = OPTIONS): Promise<Error> {
	try {
		await fetchProviderPage<Body>('https://api.example.com/page', { method: 'GET' }, options);
	} catch (err) {
		return err as Error;
	}
	throw new Error('expected fetchProviderPage to throw');
}

describe('fetchProviderPage', () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('returns the OK response untouched', async () => {
		stubFetch(new Response(JSON.stringify({ items: [1] }), { status: 200 }));
		const response = await fetchProviderPage<Body>('https://api.example.com/page', {}, OPTIONS);
		expect(await response.json()).toEqual({ items: [1] });
	});

	it('passes the url and init through to fetch', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
		global.fetch = fetchSpy;
		const init = { method: 'POST', body: '{"a":1}' };
		await fetchProviderPage<Body>('https://api.example.com/page', init, OPTIONS);
		expect(fetchSpy).toHaveBeenCalledWith('https://api.example.com/page', init);
	});

	it('classifies a network failure as retryable, naming the provider and position', async () => {
		stubFetch(new Error('ECONNRESET'));
		const err = await thrown();
		expect(err).toBeInstanceOf(RetryableProviderError);
		expect(err.message).toBe('Network error fetching Acme page at offset 200: ECONNRESET');
	});

	it('classifies 429 as retryable', async () => {
		stubFetch(new Response('slow down', { status: 429 }));
		const err = await thrown();
		expect(err).toBeInstanceOf(RetryableProviderError);
		expect(err.message).toBe('Acme rate limit (429) at offset 200');
	});

	it.each([502, 503, 504])('classifies gateway status %i as retryable', async (status) => {
		stubFetch(new Response('upstream down', { status }));
		const err = await thrown();
		expect(err).toBeInstanceOf(RetryableProviderError);
		expect(err.message).toContain(`(${status})`);
	});

	it('keeps 500 permanent, with the provider message when the body carries one', async () => {
		stubFetch(new Response(JSON.stringify({ message: 'Invalid API key' }), { status: 500 }));
		const err = await thrown();
		expect(err).not.toBeInstanceOf(RetryableProviderError);
		expect(err.message).toBe('Invalid API key');
	});

	it.each([
		['a non-JSON body', 'Internal error'],
		['a JSON body without a message', JSON.stringify({ other: 'x' })],
		['a JSON body that is not an object', JSON.stringify('just a string')],
		['an empty body', ''],
	])('falls back to the status-only message on %s', async (_label, body) => {
		stubFetch(new Response(body, { status: 400 }));
		const err = await thrown();
		expect(err).not.toBeInstanceOf(RetryableProviderError);
		expect(err.message).toBe('Acme API error: 400');
	});

	it('ignores a non-string extracted message', async () => {
		stubFetch(new Response(JSON.stringify({ message: { nested: true } }), { status: 401 }));
		const err = await thrown();
		expect(err.message).toBe('Acme API error: 401');
	});

	it('runs every thrown message through redact', async () => {
		const redact = (text: string) => text.split('sk_secret').join('[redacted]');
		const options = { ...OPTIONS, redact };

		stubFetch(new Error('connect failed for sk_secret'));
		expect((await thrown(options)).message).toBe(
			'Network error fetching Acme page at offset 200: connect failed for [redacted]'
		);

		stubFetch(new Response(JSON.stringify({ message: 'bad key sk_secret' }), { status: 401 }));
		const permanent = await thrown(options);
		expect(permanent.message).toBe('bad key [redacted]');
		expect(permanent.message).not.toContain('sk_secret');
	});
});
