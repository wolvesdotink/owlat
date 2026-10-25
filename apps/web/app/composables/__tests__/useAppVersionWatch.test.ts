/**
 * The browser wiring of the version watch: where it applies at all, and what
 * it asks the server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vue-router', () => ({
	useRouter: () => ({ beforeEach: () => () => {}, resolve: () => ({ href: '/' }) }),
}));

let runtimeConfig: { app: { buildId: string; baseURL: string } };

beforeEach(() => {
	runtimeConfig = { app: { buildId: '3f1c2a', baseURL: '/' } };
	vi.stubGlobal('useRuntimeConfig', () => runtimeConfig);
	vi.resetModules();
});
afterEach(() => {
	vi.unstubAllGlobals();
	delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
});

async function load() {
	return (await import('../useAppVersionWatch')).useAppVersionWatch;
}

describe('useAppVersionWatch', () => {
	it('is one watch per tab', async () => {
		const useAppVersionWatch = await load();
		const first = useAppVersionWatch();
		expect(first).not.toBeNull();
		expect(useAppVersionWatch()).toBe(first);
	});

	it('does not apply to a build without an id, or in the desktop app', async () => {
		runtimeConfig.app.buildId = 'test';
		expect((await load())()).toBeNull();

		vi.resetModules();
		runtimeConfig.app.buildId = '3f1c2a';
		(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
		expect((await load())()).toBeNull();
	});

	it('asks the server under the app base URL, uncached, and reads its answer', async () => {
		runtimeConfig.app.baseURL = '/owlat/';
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ buildId: 'next', version: '0.6.17' }), { status: 200 })
		);
		vi.stubGlobal('fetch', fetchMock);
		const watch = (await load())()!;
		await watch.check();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/owlat/api/app-version');
		expect(init.cache).toBe('no-store');
		expect(watch.update.value).toEqual({ buildId: 'next', version: '0.6.17' });
	});

	it('treats an error status as no answer', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{"buildId":"next"}', { status: 503 }))
		);
		const watch = (await load())()!;
		await watch.check();
		expect(watch.update.value).toBeNull();
	});
});
