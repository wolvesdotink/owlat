import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch } from '~/lib/csrfFetch';

/**
 * `apiFetch` is the one door every state-changing request goes through, so what
 * matters here is that it stamps the token, that it withholds it from another
 * origin, and that it dispatches through whatever `globalThis.$fetch` is AT
 * CALL TIME.
 *
 * That last one is not a detail. The first attempt at this fix patched
 * `globalThis.$fetch` from a plugin — which does nothing, because Nuxt's
 * auto-imported `$fetch` is a `const` captured from the global before any
 * plugin runs (`#build/fetch.mjs`). Capturing the instance here would
 * reintroduce the same class of dead code, so the dispatch is pinned.
 */

interface RecordedCall {
	request: unknown;
	options: Record<string, unknown>;
}

let calls: RecordedCall[];
let original: unknown;

function stubFetch(): void {
	const record = (request: unknown, options?: Record<string, unknown>) => {
		calls.push({ request, options: options ?? {} });
	};
	const instance = ((request: unknown, options?: Record<string, unknown>) => {
		record(request, options);
		return Promise.resolve({ ok: true });
	}) as unknown as Record<string, unknown>;
	instance['raw'] = (request: unknown, options?: Record<string, unknown>) => {
		record(request, options);
		return Promise.resolve({ status: 200, _data: { ok: true } });
	};
	globalThis.$fetch = instance as unknown as typeof globalThis.$fetch;
}

function headerOf(call: RecordedCall, name = 'csrf-token'): string | null {
	const headers = call.options['headers'];
	return headers instanceof Headers ? headers.get(name) : null;
}

beforeEach(() => {
	calls = [];
	original = globalThis.$fetch;
	stubFetch();
	document.head.innerHTML = '<meta name="csrf-token" content="tok-123">';
	// nuxt-csurf publishes the configured header name on the public config.
	vi.stubGlobal('useRuntimeConfig', () => ({ public: { csurf: { headerName: 'csrf-token' } } }));
});

afterEach(() => {
	globalThis.$fetch = original as typeof globalThis.$fetch;
	document.head.innerHTML = '';
	vi.unstubAllGlobals();
});

describe('apiFetch', () => {
	it('stamps the token on a same-origin POST', async () => {
		await apiFetch('/api/system/apply-profiles', { method: 'POST', body: { flags: {} } });

		expect(calls).toHaveLength(1);
		expect(headerOf(calls[0]!)).toBe('tok-123');
		expect(calls[0]!.request).toBe('/api/system/apply-profiles');
		expect(calls[0]!.options['body']).toEqual({ flags: {} });
	});

	it('leaves reads and cross-origin requests alone', async () => {
		await apiFetch('/api/system/profile-drift');
		await apiFetch('https://other.example/collect', { method: 'POST' });

		expect(headerOf(calls[0]!)).toBeNull();
		expect(headerOf(calls[1]!)).toBeNull();
	});

	it('stamps the token on .raw, and hands back the response', async () => {
		const res = await apiFetch.raw<{ ok: boolean }>('/api/setup/validate-provider', {
			method: 'POST',
			body: '{}',
			ignoreResponseError: true,
		});

		expect(headerOf(calls[0]!)).toBe('tok-123');
		expect(res.status).toBe(200);
	});

	it('dispatches through the CURRENT globalThis.$fetch, never a captured one', async () => {
		// Whatever instance existed when this module was imported is stale by
		// now — a test stub, or in the app the binding Nuxt froze at boot.
		calls = [];
		stubFetch();
		await apiFetch('/api/system/update', { method: 'POST' });

		expect(calls).toHaveLength(1);
		expect(headerOf(calls[0]!)).toBe('tok-123');
	});

	it('honors a configured header name', async () => {
		vi.stubGlobal('useRuntimeConfig', () => ({
			public: { csurf: { headerName: 'x-owlat-csrf' } },
		}));
		await apiFetch('/api/system/update', { method: 'POST' });

		expect(headerOf(calls[0]!, 'x-owlat-csrf')).toBe('tok-123');
	});

	it('falls back to the default header outside a Nuxt context', async () => {
		// A caller running off a timer — the setup wizard's restart poller — has
		// left the context `useRuntimeConfig()` needs.
		vi.stubGlobal('useRuntimeConfig', () => {
			throw new Error('[nuxt] instance unavailable');
		});
		await apiFetch('/api/setup/apply', { method: 'POST' });

		expect(headerOf(calls[0]!)).toBe('tok-123');
	});

	it('sends the request unchanged when the document carries no token', async () => {
		document.head.innerHTML = '';
		await apiFetch('/api/system/update', { method: 'POST' });

		expect(calls).toHaveLength(1);
		expect(headerOf(calls[0]!)).toBeNull();
	});
});

/**
 * A tab's token goes stale on its own: it is the `__Host-csrf` cookie encrypted
 * under a secret nuxt-csurf generates at BUILD time, and this app is
 * `ssr:false`, so a tab renders one document and holds that token for its whole
 * life. The first `web` image an in-app update promotes therefore 403s every
 * POST the tab makes afterwards — which each caller reported as its own
 * unrelated failure ("Could not reach the updater", and the host-CLI fallback
 * copy that goes with it).
 */
describe('apiFetch — a stale token heals itself', () => {
	interface Scripted {
		/** Status to fail the first attempt at the guarded request with. */
		status: number;
		/** Error body for that failure. */
		data: unknown;
		/** Token `/api/csrf-token` hands back, or a rejection when absent. */
		refreshed?: string;
	}

	function stubRejectingFetch(script: Scripted): void {
		const instance = ((request: unknown, options?: Record<string, unknown>) => {
			if (request === '/api/csrf-token') {
				if (!script.refreshed) return Promise.reject(new Error('offline'));
				return Promise.resolve({ token: script.refreshed });
			}
			calls.push({ request, options: options ?? {} });
			if (calls.length > 1) return Promise.resolve({ ok: true });
			return Promise.reject(
				Object.assign(new Error('403'), { status: script.status, data: script.data })
			);
		}) as unknown as Record<string, unknown>;
		instance['raw'] = instance as unknown as Record<string, unknown>;
		globalThis.$fetch = instance as unknown as typeof globalThis.$fetch;
	}

	const CSRF_403 = { statusCode: 403, statusMessage: 'CSRF Token Mismatch' };

	it('re-sends the request with a freshly minted token', async () => {
		stubRejectingFetch({ status: 403, data: CSRF_403, refreshed: 'tok-fresh' });

		await expect(apiFetch('/api/system/apply-profiles', { method: 'POST' })).resolves.toEqual({
			ok: true,
		});

		expect(calls).toHaveLength(2);
		expect(headerOf(calls[0]!)).toBe('tok-123');
		expect(headerOf(calls[1]!)).toBe('tok-fresh');
		// The document carries the live token, so the NEXT caller — one that left
		// the Nuxt context and only has the DOM to read — starts from it.
		expect(document.head.querySelector('meta[name="csrf-token"]')?.getAttribute('content')).toBe(
			'tok-fresh'
		);
	});

	it('surfaces a 403 that is not the CSRF gate, untouched', async () => {
		stubRejectingFetch({
			status: 403,
			data: { statusCode: 403, message: 'Platform admin access required' },
			refreshed: 'tok-fresh',
		});

		await expect(apiFetch('/api/system/apply-profiles', { method: 'POST' })).rejects.toThrow();
		expect(calls).toHaveLength(1);
	});

	it('surfaces the original failure when no fresh token can be had', async () => {
		stubRejectingFetch({ status: 403, data: CSRF_403 });

		await expect(apiFetch('/api/system/apply-profiles', { method: 'POST' })).rejects.toThrow();
		expect(calls).toHaveLength(1);
	});

	it('does not retry a request it never put a token on', async () => {
		// Cross-origin: the token is deliberately withheld, so a 403 from there is
		// the other origin's answer and not ours to re-ask.
		stubRejectingFetch({ status: 403, data: CSRF_403, refreshed: 'tok-fresh' });

		await expect(
			apiFetch('https://elsewhere.example.com/api/thing', { method: 'POST' })
		).rejects.toThrow();
		expect(calls).toHaveLength(1);
	});

	it('mints one token for a burst of simultaneous rejections', async () => {
		let minted = 0;
		const instance = ((request: unknown, options?: Record<string, unknown>) => {
			if (request === '/api/csrf-token') {
				minted += 1;
				return Promise.resolve({ token: `tok-fresh-${minted}` });
			}
			calls.push({ request, options: options ?? {} });
			if (calls.length > 2) return Promise.resolve({ ok: true });
			return Promise.reject(Object.assign(new Error('403'), { status: 403, data: CSRF_403 }));
		}) as unknown as Record<string, unknown>;
		globalThis.$fetch = instance as unknown as typeof globalThis.$fetch;

		await Promise.all([
			apiFetch('/api/setup/apply', { method: 'POST' }),
			apiFetch('/api/setup/restart', { method: 'POST' }),
		]);

		expect(minted).toBe(1);
		expect(headerOf(calls[2]!)).toBe('tok-fresh-1');
		expect(headerOf(calls[3]!)).toBe('tok-fresh-1');
	});
});
