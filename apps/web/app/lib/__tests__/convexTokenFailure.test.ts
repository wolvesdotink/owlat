import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Convex client only sees `null` when the token fetch fails. The plugin's
 * auth-loss handler needs to know why: a session the server turned away is a
 * sign-out, a request that never got an answer is worth another try.
 */

vi.mock('~/lib/auth-client', () => ({ desktopConvexTokenRequest: () => null, authClient: {} }));
vi.mock('~/lib/desktop/activeWorkspace', () => ({ isDesktopRuntime: () => false }));

const fetchMock = vi.fn();

async function loadModule() {
	vi.resetModules();
	return import('~/lib/convex-auth');
}

function tokenResponse(): Response {
	const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
	return new Response(JSON.stringify({ token: `header.${payload}.signature` }), { status: 200 });
}

describe('lastConvexTokenFailure', () => {
	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});

	it.each([
		['a 401', 'no-session', () => new Response('{}', { status: 401 })],
		['a 403', 'no-session', () => new Response('{}', { status: 403 })],
		['a 200 without a token', 'no-session', () => new Response('{"token":null}', { status: 200 })],
		['a 503', 'unreachable', () => new Response('{}', { status: 503 })],
		['a 502 from the proxy', 'unreachable', () => new Response('bad gateway', { status: 502 })],
		['a body that is not JSON', 'unreachable', () => new Response('<html>', { status: 200 })],
		[
			'a network error',
			'unreachable',
			() => {
				throw new TypeError('Failed to fetch');
			},
		],
	])('reads %s as %s', async (_label, expected, respond) => {
		fetchMock.mockImplementation(async () => respond());
		const auth = await loadModule();
		await expect(auth.getConvexAuthToken(true)).resolves.toBeNull();
		expect(auth.lastConvexTokenFailure()).toBe(expected);
	});

	it('clears after a fetch that produced a token, and on a cache reset', async () => {
		fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 503 }));
		fetchMock.mockImplementation(async () => tokenResponse());
		const auth = await loadModule();

		await auth.getConvexAuthToken(true);
		expect(auth.lastConvexTokenFailure()).toBe('unreachable');
		await expect(auth.getConvexAuthToken(true)).resolves.toMatch(/^header\./);
		expect(auth.lastConvexTokenFailure()).toBeNull();

		fetchMock.mockImplementation(async () => new Response('{}', { status: 401 }));
		await auth.getConvexAuthToken(true);
		expect(auth.lastConvexTokenFailure()).toBe('no-session');
		auth.resetConvexAuthTokenCache();
		expect(auth.lastConvexTokenFailure()).toBeNull();
	});
});
