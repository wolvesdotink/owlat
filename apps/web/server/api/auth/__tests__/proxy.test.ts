// @vitest-environment node
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as h3 from 'h3';
import { afterEach, describe, expect, it, vi } from 'vitest';

const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()));
					server.closeAllConnections();
				})
		)
	);
	vi.unstubAllGlobals();
});

/** Serves the real proxy handler with h3's helpers as the Nitro auto-imports. */
async function mountProxy(convexSiteUrlInternal: string): Promise<string> {
	for (const name of [
		'defineEventHandler',
		'createError',
		'readRawBody',
		'getHeaders',
		'getHeader',
		'getRequestIP',
		'appendResponseHeader',
		'setHeader',
		'setResponseStatus',
	] as const) {
		vi.stubGlobal(name, h3[name]);
	}
	vi.stubGlobal('useRuntimeConfig', () => ({ convexSiteUrlInternal, public: {} }));
	vi.resetModules();
	const { default: handler } = await import('../[...]');
	const app = h3.createApp().use(handler);
	return listen(createServer(h3.toNodeListener(app)));
}

describe('auth proxy redirects', () => {
	it('returns the upstream redirect and session cookies without fetching the callback', async () => {
		const callbackRequest = vi.fn();
		const callbackOrigin = await listen(
			createServer((request, response) => {
				callbackRequest(request.headers);
				response.end('private callback response');
			})
		);
		const location = `${callbackOrigin}/callback?error=INVALID_TOKEN`;
		const upstreamRequest = vi.fn();
		const upstreamOrigin = await listen(
			createServer((request, response) => {
				upstreamRequest(request.url, request.headers);
				response.writeHead(302, {
					Location: location,
					'Set-Cookie': [
						'better-auth.session_token=new-session; Domain=convex.example; Path=/; HttpOnly; SameSite=Lax',
						'better-auth.session_data=new-data; Path=/; HttpOnly; SameSite=Lax',
					],
				});
				response.end();
			})
		);
		const proxyOrigin = await mountProxy(upstreamOrigin);
		const path = '/api/auth/verify-email?token=invalid&callbackURL=' + encodeURIComponent(location);
		const response = await fetch(proxyOrigin + path, {
			redirect: 'manual',
			headers: { 'Better-Auth-Cookie': 'desktop-session=secret' },
		});

		expect(upstreamRequest).toHaveBeenCalledOnce();
		expect(upstreamRequest.mock.calls[0]?.[0]).toBe(path);
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe(location);
		expect(response.headers.getSetCookie()).toEqual([
			'better-auth.session_token=new-session; Path=/; HttpOnly; SameSite=Lax',
			'better-auth.session_data=new-data; Path=/; HttpOnly; SameSite=Lax',
		]);
		expect(await response.text()).toBe('');
		expect(callbackRequest).not.toHaveBeenCalled();
	});

	it('forwards upstream response headers except the ones the proxy owns', async () => {
		const upstreamOrigin = await listen(
			createServer((_request, response) => {
				response.writeHead(200, {
					'Content-Type': 'application/json',
					'X-Owlat-Upstream': 'kept',
					'Set-Cookie': 'better-auth.session_token=s; Path=/; HttpOnly',
				});
				response.end('{"ok":true}');
			})
		);
		const proxyOrigin = await mountProxy(upstreamOrigin);

		const response = await fetch(proxyOrigin + '/api/auth/get-session');

		expect(response.status).toBe(200);
		expect(response.headers.get('x-owlat-upstream')).toBe('kept');
		expect(response.headers.get('content-type')).toBe('application/json');
		// Set-Cookie is rewritten by the proxy, not copied verbatim alongside it.
		expect(response.headers.getSetCookie()).toEqual([
			'better-auth.session_token=s; Path=/; HttpOnly; SameSite=Lax',
		]);
		expect(await response.text()).toBe('{"ok":true}');
	});

	it('refuses with a 500 and no upstream call when the Convex site URL cannot form a URL', async () => {
		const proxyOrigin = await mountProxy('not a url');
		// The proxy's own upstream call goes through the global `fetch`; the test
		// reaches the proxy with the real one captured first.
		const realFetch = globalThis.fetch;
		const upstreamFetch = vi.fn();
		vi.stubGlobal('fetch', upstreamFetch);
		const response = await realFetch(proxyOrigin + '/api/auth/get-session');

		// h3 keeps a 500's message out of the response body, so the refusal shows
		// as the status plus the upstream call that never happened.
		expect(response.status).toBe(500);
		expect(upstreamFetch).not.toHaveBeenCalled();
	});
});
