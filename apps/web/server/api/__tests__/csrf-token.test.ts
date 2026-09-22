import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Route test for `GET /api/csrf-token`.
 *
 * The route exists so a tab can replace a token that has gone stale — the
 * `__Host-csrf` cookie is encrypted under a secret nuxt-csurf generates at
 * BUILD time, so the first `web` image an in-app update promotes invalidates
 * the token every open tab is holding, and an `ssr:false` SPA never re-renders
 * the document that carried it.
 *
 * Two properties: it hands back the token nuxt-csurf minted for THIS request
 * (never one of its own), and it refuses rather than inventing one when the
 * module is not running, since a made-up token would fail the middleware and
 * turn a self-healing retry into a loop.
 */

interface RouteResult {
	token: string;
}

interface ThrownError {
	statusCode: number;
	message: string;
}

const headers: Record<string, string> = {};

beforeEach(() => {
	for (const key of Object.keys(headers)) delete headers[key];
	vi.stubGlobal('defineEventHandler', <T>(handler: T) => handler);
	vi.stubGlobal('setHeader', (_event: unknown, name: string, value: string) => {
		headers[name] = value;
	});
	vi.stubGlobal('createError', (err: ThrownError) => Object.assign(new Error(err.message), err));
	vi.resetModules();
});

afterEach(() => vi.unstubAllGlobals());

async function callRoute(context: Record<string, unknown>): Promise<RouteResult> {
	const mod = await import('../csrf-token.get');
	const handler = mod.default as unknown as (event: unknown) => RouteResult;
	return handler({ context });
}

describe('GET /api/csrf-token', () => {
	it('returns the token nuxt-csurf minted for this request', async () => {
		expect(await callRoute({ csrfToken: 'iv==:cipher==' })).toEqual({ token: 'iv==:cipher==' });
	});

	it('is never cached — the cookie it is bound to rides this response', async () => {
		await callRoute({ csrfToken: 'iv==:cipher==' });
		expect(headers['cache-control']).toBe('no-store');
	});

	it('refuses when the module is not minting tokens', async () => {
		await expect(callRoute({})).rejects.toMatchObject({ statusCode: 503 });
	});
});
