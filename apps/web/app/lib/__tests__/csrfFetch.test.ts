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
