import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The plugin wraps the global `$fetch` so every same-origin POST/PUT/PATCH
 * carries nuxt-csurf's `csrf-token` header. Without it the middleware answers
 * 403 before the route handler runs — which is how "Apply & restart", the
 * in-app updater and the setup wizard all shipped broken.
 *
 * The driver here is a stand-in ofetch instance that records what it was
 * called with, so the assertions are about the decoration, not about network.
 */

interface RecordedCall {
	request: unknown;
	options: Record<string, unknown>;
}

type FetchLike = ((request: unknown, options?: Record<string, unknown>) => Promise<unknown>) & {
	raw: (request: unknown, options?: Record<string, unknown>) => Promise<unknown>;
	native: (...args: unknown[]) => Promise<unknown>;
	create: (defaults?: Record<string, unknown>) => FetchLike;
};

function recorder(): { calls: RecordedCall[]; instance: FetchLike } {
	const calls: RecordedCall[] = [];
	const record = (request: unknown, options?: Record<string, unknown>) => {
		calls.push({ request, options: options ?? {} });
	};

	function build(): FetchLike {
		const instance = ((request: unknown, options?: Record<string, unknown>) => {
			record(request, options);
			return Promise.resolve({ ok: true });
		}) as FetchLike;
		instance.raw = (request: unknown, options?: Record<string, unknown>) => {
			record(request, options);
			return Promise.resolve({ status: 200 });
		};
		instance.native = () => Promise.resolve({ ok: true });
		instance.create = () => build();
		return instance;
	}

	return { calls, instance: build() };
}

async function installPlugin(headerName = 'csrf-token'): Promise<void> {
	vi.resetModules();
	vi.stubGlobal('defineNuxtPlugin', (def: unknown) => def);
	vi.stubGlobal('useCsrf', () => ({ csrf: 'unused-here', headerName }));
	const mod = await import('../0.csrf-fetch.client');
	(mod.default as { setup: () => void }).setup();
}

function headerOf(call: RecordedCall, name = 'csrf-token'): string | null {
	const headers = call.options['headers'];
	return headers instanceof Headers ? headers.get(name) : null;
}

let original: unknown;
let calls: RecordedCall[];

beforeEach(() => {
	original = globalThis.$fetch;
	const { calls: recorded, instance } = recorder();
	calls = recorded;
	globalThis.$fetch = instance as unknown as typeof globalThis.$fetch;
	document.head.innerHTML = '<meta name="csrf-token" content="tok-123">';
});

afterEach(() => {
	globalThis.$fetch = original as typeof globalThis.$fetch;
	document.head.innerHTML = '';
	vi.unstubAllGlobals();
});

describe('csrf fetch plugin', () => {
	it('stamps the token on a same-origin POST', async () => {
		await installPlugin();
		await $fetch('/api/system/apply-profiles', { method: 'POST', body: { flags: {} } });

		expect(calls).toHaveLength(1);
		expect(headerOf(calls[0]!)).toBe('tok-123');
		// Everything else rides along untouched.
		expect(calls[0]!.request).toBe('/api/system/apply-profiles');
		expect(calls[0]!.options['body']).toEqual({ flags: {} });
	});

	it('leaves reads and cross-origin requests alone', async () => {
		await installPlugin();
		await $fetch('/api/system/profile-drift');
		await $fetch('https://other.example/collect', { method: 'POST' });

		expect(headerOf(calls[0]!)).toBeNull();
		expect(headerOf(calls[1]!)).toBeNull();
	});

	it('keeps a call site’s own onRequest hook — the reason it wraps the instance rather than passing defaults to create()', async () => {
		await installPlugin();
		const onRequest = vi.fn();
		await $fetch('/api/setup/apply', { method: 'POST', onRequest });

		expect(calls[0]!.options['onRequest']).toBe(onRequest);
		expect(headerOf(calls[0]!)).toBe('tok-123');
	});

	it('decorates $fetch.raw', async () => {
		await installPlugin();
		await $fetch.raw('/api/setup/validate-provider', { method: 'POST', body: '{}' });

		expect(headerOf(calls[0]!)).toBe('tok-123');
	});

	it('decorates instances derived with $fetch.create', async () => {
		await installPlugin();
		const derived = $fetch.create({ retry: 0 });
		await derived('/api/system/update', { method: 'POST' });

		expect(headerOf(calls[0]!)).toBe('tok-123');
	});

	it('honors a non-default header name', async () => {
		await installPlugin('x-owlat-csrf');
		await $fetch('/api/system/update', { method: 'POST' });

		expect(headerOf(calls[0]!, 'x-owlat-csrf')).toBe('tok-123');
	});

	it('sends the request unchanged when the document carries no token', async () => {
		document.head.innerHTML = '';
		await installPlugin();
		await $fetch('/api/system/update', { method: 'POST' });

		expect(calls).toHaveLength(1);
		expect(headerOf(calls[0]!)).toBeNull();
	});

	it('leaves $fetch untouched when the module is disabled', async () => {
		const before = globalThis.$fetch;
		await installPlugin('');
		expect(globalThis.$fetch).toBe(before);
	});
});
