/**
 * `authedConvexClient`: exchanges the better-auth session cookie for a Convex
 * JWT through the internal token proxy and returns a client carrying it. The
 * proxy URL is built from the configured site origin, never the request Host,
 * so a spoofed Host cannot make the server forward the caller's cookie
 * elsewhere.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConvexHttpClient } from 'convex/browser';
import { authedConvexClient } from '../authedConvexClient';
import { installNitroGlobals, requestEvent } from './nitro';

const CONVEX_URL = 'https://convex.example.com';
const SITE_URL = 'https://owlat.example';
const COOKIE = 'better-auth.session_token=abc123';

const fetchMock = vi.fn<typeof fetch>();

function tokenResponse(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	} as unknown as Response;
}

beforeEach(() => {
	installNitroGlobals({ convexUrl: CONVEX_URL, siteUrl: SITE_URL });
	fetchMock.mockReset().mockResolvedValue(tokenResponse(200, { token: 'jwt-1' }));
	vi.stubGlobal('fetch', fetchMock);
});

describe('authedConvexClient', () => {
	it('returns a client authenticated with the exchanged token', async () => {
		const setAuth = vi.spyOn(ConvexHttpClient.prototype, 'setAuth');

		const client = await authedConvexClient(requestEvent({ cookie: COOKIE }));

		expect(client).toBeInstanceOf(ConvexHttpClient);
		expect(setAuth).toHaveBeenCalledWith('jwt-1');
		setAuth.mockRestore();
	});

	it('exchanges through the configured origin, forwarding only the cookie', async () => {
		await authedConvexClient(
			requestEvent({ cookie: COOKIE, host: 'evil.example', authorization: 'Bearer leak' })
		);

		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe(`${SITE_URL}/api/auth/convex/token`);
		expect(init).toEqual({ method: 'GET', headers: { cookie: COOKIE } });
	});

	it('answers 503 before touching the network when Convex is not configured', async () => {
		installNitroGlobals({ convexUrl: '', siteUrl: SITE_URL });

		await expect(authedConvexClient(requestEvent({ cookie: COOKIE }))).rejects.toMatchObject({
			statusCode: 503,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('answers 401 without a session cookie and never calls the token proxy', async () => {
		await expect(authedConvexClient(requestEvent())).rejects.toMatchObject({
			statusCode: 401,
			message: 'Not authenticated',
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('answers 401 when the proxy rejects the cookie', async () => {
		fetchMock.mockResolvedValue(tokenResponse(401, { error: 'expired' }));

		await expect(authedConvexClient(requestEvent({ cookie: COOKIE }))).rejects.toMatchObject({
			statusCode: 401,
		});
	});

	it('answers 401 when the proxy has no token for the session', async () => {
		fetchMock.mockResolvedValue(tokenResponse(200, { token: null }));

		await expect(authedConvexClient(requestEvent({ cookie: COOKIE }))).rejects.toMatchObject({
			statusCode: 401,
			message: 'No auth token',
		});
	});
});
