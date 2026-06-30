import { describe, it, expect, afterEach, vi } from 'vitest';
import {
	validateOpenAIKey,
	validateOpenRouterKey,
	validateResendKey,
	validatePostHogHost,
	validateGoogleSafeBrowsingKey,
} from '../validators';

/** Stub global fetch with a Response carrying just the status these validators read. */
function stubStatus(status: number) {
	const fn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status }));
	vi.stubGlobal('fetch', fn);
	return fn;
}

/** Stub global fetch so it rejects, simulating a network failure / abort. */
function stubReject(message: string) {
	const fn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
		throw new Error(message);
	});
	vi.stubGlobal('fetch', fn);
	return fn;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('validateOpenAIKey', () => {
	it('accepts a 200 response', async () => {
		const fetchMock = stubStatus(200);
		const res = await validateOpenAIKey('sk-test');
		expect(res.ok).toBe(true);
		expect(res.message).toMatch(/accepted/i);
		// Hits the models endpoint with a bearer header.
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe('https://api.openai.com/v1/models');
		expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk-test' });
	});

	it('honors a custom base URL', async () => {
		const fetchMock = stubStatus(200);
		await validateOpenAIKey('sk-test', 'https://proxy.local/v1');
		expect(fetchMock.mock.calls[0]![0]).toBe('https://proxy.local/v1/models');
	});

	it('rejects a 401 with an Unauthorized message', async () => {
		stubStatus(401);
		const res = await validateOpenAIKey('sk-bad');
		expect(res.ok).toBe(false);
		expect(res.message).toMatch(/401/);
	});

	it('reports a non-auth HTTP status', async () => {
		stubStatus(500);
		const res = await validateOpenAIKey('sk-bad');
		expect(res.ok).toBe(false);
		expect(res.message).toContain('500');
	});

	it('catches a thrown fetch (network error)', async () => {
		stubReject('getaddrinfo ENOTFOUND');
		const res = await validateOpenAIKey('sk-test');
		expect(res.ok).toBe(false);
		expect(res.message).toContain('getaddrinfo ENOTFOUND');
	});
});

describe('validateOpenRouterKey', () => {
	it('accepts a 200 response', async () => {
		const fetchMock = stubStatus(200);
		const res = await validateOpenRouterKey('sk-or-test');
		expect(res.ok).toBe(true);
		expect(res.message).toMatch(/accepted/i);
		expect(fetchMock.mock.calls[0]![0]).toBe('https://openrouter.ai/api/v1/models');
	});

	it('rejects a 401', async () => {
		stubStatus(401);
		const res = await validateOpenRouterKey('sk-or-bad');
		expect(res.ok).toBe(false);
		expect(res.message).toMatch(/401/);
	});

	it('catches a thrown fetch', async () => {
		stubReject('socket hang up');
		const res = await validateOpenRouterKey('sk-or-test');
		expect(res.ok).toBe(false);
		expect(res.message).toContain('socket hang up');
	});
});

describe('validateResendKey', () => {
	it('accepts a 200 response', async () => {
		const fetchMock = stubStatus(200);
		const res = await validateResendKey('re_test');
		expect(res.ok).toBe(true);
		expect(res.message).toMatch(/accepted/i);
		expect(fetchMock.mock.calls[0]![0]).toBe('https://api.resend.com/domains');
	});

	it('rejects a 401', async () => {
		stubStatus(401);
		const res = await validateResendKey('re_bad');
		expect(res.ok).toBe(false);
		expect(res.message).toMatch(/rejected/i);
	});

	it('rejects a 403', async () => {
		stubStatus(403);
		const res = await validateResendKey('re_bad');
		expect(res.ok).toBe(false);
		expect(res.message).toMatch(/rejected/i);
	});

	it('catches a thrown fetch', async () => {
		stubReject('ECONNREFUSED');
		const res = await validateResendKey('re_test');
		expect(res.ok).toBe(false);
		expect(res.message).toContain('ECONNREFUSED');
	});
});

describe('validatePostHogHost', () => {
	it('accepts any reachable host (status < 500)', async () => {
		const fetchMock = stubStatus(200);
		const res = await validatePostHogHost('https://eu.posthog.com', 'phc_1');
		expect(res.ok).toBe(true);
		expect(res.message).toMatch(/reachable/i);
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe('https://eu.posthog.com/decide');
		expect((init as RequestInit).method).toBe('POST');
	});

	it('prefixes a bare host with https://', async () => {
		const fetchMock = stubStatus(200);
		await validatePostHogHost('app.posthog.com');
		expect(fetchMock.mock.calls[0]![0]).toBe('https://app.posthog.com/decide');
	});

	it('treats a 5xx as an unreachable host', async () => {
		stubStatus(503);
		const res = await validatePostHogHost('https://ph.example.com');
		expect(res.ok).toBe(false);
		expect(res.message).toContain('503');
	});

	it('catches a thrown fetch without leaking the raw error (SSRF probe oracle)', async () => {
		stubReject('ECONNREFUSED 127.0.0.1:6379');
		const res = await validatePostHogHost('https://ph.example.com');
		expect(res.ok).toBe(false);
		// The raw fetch error must NOT be echoed — it would turn this into a
		// reachability/port-probe oracle for an unauthenticated setup caller.
		expect(res.message).not.toContain('ECONNREFUSED');
		expect(res.message).toMatch(/not reachable/i);
	});

	it('blocks private/loopback/link-local hosts (SSRF guard)', async () => {
		for (const host of [
			'http://127.0.0.1:6379',
			'http://169.254.169.254/',
			'http://10.0.0.5',
			'http://192.168.1.1',
			'http://localhost:3210',
			'http://[::1]',
		]) {
			const res = await validatePostHogHost(host);
			expect(res.ok).toBe(false);
			expect(res.message).toMatch(/public address/i);
		}
	});
});

describe('validateGoogleSafeBrowsingKey', () => {
	it('accepts a 200 response', async () => {
		const fetchMock = stubStatus(200);
		const res = await validateGoogleSafeBrowsingKey('gsb-key');
		expect(res.ok).toBe(true);
		expect(res.message).toMatch(/accepted/i);
		// Key is URL-encoded into the query string.
		expect(fetchMock.mock.calls[0]![0]).toBe(
			'https://safebrowsing.googleapis.com/v4/threatLists?key=gsb-key',
		);
	});

	it('rejects a 403', async () => {
		stubStatus(403);
		const res = await validateGoogleSafeBrowsingKey('gsb-bad');
		expect(res.ok).toBe(false);
		expect(res.message).toMatch(/rejected/i);
	});

	it('rejects a 400', async () => {
		stubStatus(400);
		const res = await validateGoogleSafeBrowsingKey('gsb-bad');
		expect(res.ok).toBe(false);
		expect(res.message).toMatch(/rejected/i);
	});

	it('catches a thrown fetch', async () => {
		stubReject('network down');
		const res = await validateGoogleSafeBrowsingKey('gsb-key');
		expect(res.ok).toBe(false);
		expect(res.message).toContain('network down');
	});
});
