import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `getMtaBaseUrl` / `getMtaConfig` resolve the MTA address once for every
 * caller, and `mtaFetch` is the one authenticated, time-bounded request to it.
 */

const env = vi.hoisted(() => ({ values: {} as Record<string, string | undefined> }));
vi.mock('../../lib/env', () => ({
	getOptional: (name: string) => env.values[name],
}));

import { getMtaBaseUrl, getMtaConfig, MTA_FETCH_TIMEOUT_MS, mtaFetch } from '../mtaClient';

const fetchMock = vi.fn();
const config = { baseUrl: 'http://mta.test', apiKey: 'mta-key' };

beforeEach(() => {
	env.values = {};
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('getMtaBaseUrl / getMtaConfig', () => {
	it('prefers MTA_INTERNAL_URL and trims trailing slashes', () => {
		env.values = {
			MTA_INTERNAL_URL: 'http://mta.internal//',
			MTA_API_URL: 'https://mta.public',
			MTA_API_KEY: 'k',
		};
		expect(getMtaBaseUrl()).toBe('http://mta.internal');
		expect(getMtaConfig()).toEqual({ baseUrl: 'http://mta.internal', apiKey: 'k' });
	});

	it('falls back to MTA_API_URL', () => {
		env.values = { MTA_API_URL: 'https://mta.public/', MTA_API_KEY: 'k' };
		expect(getMtaBaseUrl()).toBe('https://mta.public');
		expect(getMtaConfig()?.baseUrl).toBe('https://mta.public');
	});

	it('resolves the base URL without a key, but no config', () => {
		env.values = { MTA_INTERNAL_URL: 'http://mta.internal' };
		expect(getMtaBaseUrl()).toBe('http://mta.internal');
		expect(getMtaConfig()).toBeNull();
	});

	it('is null when no URL is set', () => {
		env.values = { MTA_API_KEY: 'k' };
		expect(getMtaBaseUrl()).toBeNull();
		expect(getMtaConfig()).toBeNull();
	});
});

describe('mtaFetch', () => {
	it('joins the path, sets the bearer header and keeps the caller init', async () => {
		fetchMock.mockResolvedValue(new Response('ok'));

		await mtaFetch(config, '/ip-reputation?organizationId=org_1', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: 'Bearer spoofed' },
			body: '{}',
		});

		const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
		expect(url).toBe('http://mta.test/ip-reputation?organizationId=org_1');
		expect(init.method).toBe('POST');
		expect(init.body).toBe('{}');
		const headers = new Headers(init.headers);
		expect(headers.get('Authorization')).toBe('Bearer mta-key');
		expect(headers.get('Content-Type')).toBe('application/json');
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it('aborts a request that has not answered by the timeout', async () => {
		vi.useFakeTimers();
		fetchMock.mockImplementation(
			(_url: string, init: RequestInit) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener('abort', () =>
						reject(new DOMException('aborted', 'AbortError'))
					);
				})
		);

		const pending = mtaFetch(config, '/health', {}, 250);
		const settled = expect(pending).rejects.toThrow('aborted');
		await vi.advanceTimersByTimeAsync(249);
		const signal = (fetchMock.mock.calls[0]![1] as RequestInit).signal!;
		expect(signal.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await settled;
		expect(signal.aborted).toBe(true);
	});

	it('uses the default timeout and clears its timer once answered', async () => {
		vi.useFakeTimers();
		fetchMock.mockResolvedValue(new Response('ok'));

		await mtaFetch(config, '/health');
		const signal = (fetchMock.mock.calls[0]![1] as RequestInit).signal!;
		await vi.advanceTimersByTimeAsync(MTA_FETCH_TIMEOUT_MS * 2);

		expect(signal.aborted).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});
});
