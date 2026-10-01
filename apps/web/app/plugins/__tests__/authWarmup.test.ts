import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The warm-up plugin must START both boot fetches (session + Convex token)
 * exactly once, and everything that asks later must reuse them: `useAuth()`
 * joins the session store built here, and the Convex client's token callback
 * joins the in-flight token request. The real better-auth client, `useAuth` and
 * `convex-auth` run against a stubbed `fetch`, so the assertions count requests.
 */

type Plugin = { enforce?: string; parallel?: boolean; setup: () => void };

let routePath = '/dashboard';
let publicConfig: Record<string, unknown> = {};
let fetchMock: ReturnType<typeof vi.fn>;
let releaseToken: (token: string | null) => void = () => {};

function requestUrl(input: unknown): string {
	if (typeof input === 'string') return input;
	if (input instanceof URL) return input.toString();
	return (input as Request).url;
}

function calls(fragment: string): number {
	return fetchMock.mock.calls.filter(([input]) => requestUrl(input).includes(fragment)).length;
}

function jwt(): string {
	const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
	return `header.${payload}.signature`;
}

/**
 * Globals set for one case and restored after it. `vi.unstubAllGlobals()` would
 * also strip the Vue auto-import stubs the setup file installs, which `useAuth`
 * needs.
 */
const restores: Array<() => void> = [];
function stub(name: string, value: unknown) {
	const target = globalThis as Record<string, unknown>;
	const had = name in target;
	const previous = target[name];
	target[name] = value;
	restores.push(() => {
		if (had) target[name] = previous;
		else delete target[name];
	});
}

async function flush() {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function loadPlugin() {
	vi.resetModules();
	stub('waitForLoaded', (await import('~/utils/waitForLoaded')).waitForLoaded);
	const plugin = (await import('../0.auth-warmup.client')).default as unknown as Plugin;
	const useAuthModule = await import('~/composables/useAuth');
	const convexAuth = await import('~/lib/convex-auth');
	return { plugin, useAuth: useAuthModule.useAuth, convexAuth };
}

describe('auth warm-up plugin', () => {
	beforeEach(() => {
		routePath = '/dashboard';
		publicConfig = { convexUrl: 'https://convex.example', setupMode: false };
		fetchMock = vi.fn((input: unknown) => {
			const url = requestUrl(input);
			if (url.includes('/convex/token')) {
				return new Promise<Response>((resolve) => {
					releaseToken = (token) =>
						resolve(new Response(JSON.stringify({ token }), { status: 200 }));
				});
			}
			if (url.includes('/get-session')) {
				return Promise.resolve(
					new Response('null', {
						status: 200,
						headers: { 'content-type': 'application/json' },
					})
				);
			}
			return Promise.reject(new Error(`unexpected request ${url}`));
		});
		stub('fetch', fetchMock);
		stub('useRoute', () => ({ path: routePath }));
		stub('useRuntimeConfig', () => ({ public: publicConfig }));
	});

	afterEach(() => {
		while (restores.length) restores.pop()?.();
	});

	it('runs first and does not hold up the plugins after it', async () => {
		const { plugin } = await loadPlugin();
		expect(plugin.enforce).toBe('pre');
		expect(plugin.parallel).toBe(true);
	});

	it('starts the session and token fetches once; later callers reuse them', async () => {
		const { plugin, useAuth, convexAuth } = await loadPlugin();

		plugin.setup();
		expect(calls('/convex/token')).toBe(1);
		await flush();
		expect(calls('/get-session')).toBe(1);

		// Route middleware and pages: the same store, no second session request.
		const first = useAuth();
		const second = useAuth();
		await first.waitUntilReady();
		await second.waitUntilReady();
		await flush();
		expect(calls('/get-session')).toBe(1);
		expect(first.status.value).toBe('unauthenticated');

		// The Convex client's first token fetch joins the one in flight.
		const clientToken = convexAuth.getConvexAuthToken(false);
		const token = jwt();
		releaseToken(token);
		await expect(clientToken).resolves.toBe(token);
		expect(calls('/convex/token')).toBe(1);
	});

	it('skips public routes, like the Convex client does', async () => {
		routePath = '/share';
		const { plugin } = await loadPlugin();

		plugin.setup();
		await flush();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('skips setup mode', async () => {
		publicConfig = { ...publicConfig, setupMode: true };
		const { plugin } = await loadPlugin();

		plugin.setup();
		await flush();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('skips the token, not the session, when no Convex URL is configured', async () => {
		publicConfig = { ...publicConfig, convexUrl: '' };
		const { plugin } = await loadPlugin();

		plugin.setup();
		await flush();
		expect(calls('/convex/token')).toBe(0);
		expect(calls('/get-session')).toBe(1);
	});

	it('does nothing on the desktop runtime, where the keychain session loads first', async () => {
		stub('__TAURI_INTERNALS__', {});
		const { plugin } = await loadPlugin();

		plugin.setup();
		await flush();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
