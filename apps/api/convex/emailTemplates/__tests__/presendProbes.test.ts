/**
 * The pre-send link and image probes. The network is two seams in
 * `lib/ssrfGuard`: the up-front blocklist check and the guarded fetch. Pinned:
 * every redirect hop is re-validated (a public host cannot bounce the probe
 * into the private network), HEAD falls back to GET, statuses classify the way
 * the Review step words them, images get measured, and the run budget and the
 * per-URL cache hold.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const validatePublicUrl = vi.hoisted(() => vi.fn());
const fetchWithGuardedDispatcher = vi.hoisted(() => vi.fn());
vi.mock('../../lib/ssrfGuard', () => ({ validatePublicUrl, fetchWithGuardedDispatcher }));

import { IMAGE_MEASURE_CAP_BYTES, clearProbeCache, probeResources } from '../presendProbes';

type Handler = (url: string, method: string) => Response | Promise<Response>;

function serve(handler: Handler) {
	fetchWithGuardedDispatcher.mockImplementation((url: string, init: RequestInit) =>
		Promise.resolve(handler(url, init.method ?? 'GET'))
	);
}

const redirect = (location: string) => new Response(null, { status: 301, headers: { location } });

beforeEach(() => {
	clearProbeCache();
	validatePublicUrl.mockReset().mockResolvedValue({ ok: true });
	fetchWithGuardedDispatcher.mockReset();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('link probes', () => {
	it('reports a working link, a missing page and a host that refuses robots', async () => {
		serve((url) => {
			if (url.endsWith('/gone')) return new Response(null, { status: 404 });
			if (url.endsWith('/members')) return new Response(null, { status: 403 });
			return new Response(null, { status: 200 });
		});

		const { links } = await probeResources(
			['https://example.com/', 'https://example.com/gone', 'https://example.com/members'],
			[]
		);

		expect(links).toEqual([
			{ url: 'https://example.com/', status: 'ok', httpStatus: 200 },
			{ url: 'https://example.com/gone', status: 'broken', httpStatus: 404 },
			{ url: 'https://example.com/members', status: 'unverified', httpStatus: 403 },
		]);
	});

	it('falls back to GET when the server refuses HEAD', async () => {
		serve((_url, method) => new Response(null, { status: method === 'HEAD' ? 405 : 200 }));

		const { links } = await probeResources(['https://example.com/page'], []);

		expect(links[0]).toMatchObject({ status: 'ok', httpStatus: 200 });
		expect(fetchWithGuardedDispatcher.mock.calls.map((call) => call[1].method)).toEqual([
			'HEAD',
			'GET',
		]);
	});

	it('validates every redirect hop and stops at one into the private network', async () => {
		validatePublicUrl.mockImplementation(async (url: string) =>
			url.startsWith('http://10.')
				? { ok: false, code: 'blocked_address', error: 'private' }
				: { ok: true }
		);
		serve((url) =>
			url === 'https://short.example/x' ? redirect('http://10.0.0.5/admin') : new Response(null)
		);

		const { links } = await probeResources(['https://short.example/x'], []);

		expect(links[0]).toEqual({ url: 'https://short.example/x', status: 'blocked' });
		expect(validatePublicUrl).toHaveBeenCalledWith('http://10.0.0.5/admin');
		expect(fetchWithGuardedDispatcher).not.toHaveBeenCalledWith(
			'http://10.0.0.5/admin',
			expect.anything()
		);
	});

	it('follows relative redirects and calls a loop broken', async () => {
		serve((url) => {
			if (url === 'https://example.com/old') return redirect('/new');
			if (url === 'https://example.com/new') return new Response(null, { status: 200 });
			return redirect('https://loop.example/');
		});

		const { links } = await probeResources(
			['https://example.com/old', 'https://loop.example/'],
			[]
		);

		expect(links[0]).toMatchObject({ status: 'ok' });
		expect(links[1]).toEqual({ url: 'https://loop.example/', status: 'broken' });
	});

	it('tells a timeout from an unreachable host', async () => {
		fetchWithGuardedDispatcher.mockImplementation(async (url: string) => {
			const error = new Error('nope');
			error.name = url.includes('slow') ? 'TimeoutError' : 'TypeError';
			throw error;
		});

		const { links } = await probeResources(['https://slow.example/', 'https://down.example/'], []);

		expect(links.map((link) => link.status)).toEqual(['timeout', 'unreachable']);
	});

	it('caches a result per URL and skips what the run budget did not reach', async () => {
		serve(() => new Response(null, { status: 200 }));
		await probeResources(['https://example.com/a'], []);
		const calls = fetchWithGuardedDispatcher.mock.calls.length;

		await probeResources(['https://example.com/a'], []);
		expect(fetchWithGuardedDispatcher.mock.calls.length).toBe(calls);

		// A clock already past the budget: nothing new is probed.
		let now = 0;
		const clock = () => {
			now += 30_000;
			return now;
		};
		const { links } = await probeResources(['https://example.com/b'], [], clock);
		expect(links).toEqual([{ url: 'https://example.com/b', status: 'skipped' }]);
	});
	it('remembers a failing link only briefly, so a recheck sees a fixed page', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		let live = false;
		serve(() => new Response(null, { status: live ? 200 : 404 }));
		const first = await probeResources(['https://example.com/launch'], []);
		expect(first.links[0]).toMatchObject({ status: 'broken' });

		live = true;
		vi.advanceTimersByTime(30_000);
		const soon = await probeResources(['https://example.com/launch'], []);
		expect(soon.links[0]).toMatchObject({ status: 'broken' });

		vi.advanceTimersByTime(31_000);
		const later = await probeResources(['https://example.com/launch'], []);
		expect(later.links[0]).toMatchObject({ status: 'ok' });

		// A working answer is kept for longer than that.
		live = false;
		vi.advanceTimersByTime(120_000);
		const cached = await probeResources(['https://example.com/launch'], []);
		expect(cached.links[0]).toMatchObject({ status: 'ok' });
	});

	it('cuts off a probe still in flight at the hard stop and reports it not checked', async () => {
		const stop = new AbortController();
		fetchWithGuardedDispatcher.mockImplementation(
			(_url: string, init: RequestInit) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
				})
		);

		const run = probeResources(['https://slow.example/'], [], Date.now, stop.signal);
		await vi.waitFor(() => expect(fetchWithGuardedDispatcher).toHaveBeenCalledTimes(1));
		stop.abort(new DOMException('stop', 'TimeoutError'));
		const { links } = await run;

		expect(links).toEqual([{ url: 'https://slow.example/', status: 'skipped' }]);
		// Not retried with GET after the stop, and not cached as a failure.
		expect(fetchWithGuardedDispatcher).toHaveBeenCalledTimes(1);
		serve(() => new Response(null, { status: 200 }));
		const again = await probeResources(['https://slow.example/'], []);
		expect(again.links[0]).toMatchObject({ status: 'ok' });
	});
});

describe('image probes', () => {
	it('takes the size from Content-Length when the server sends one', async () => {
		serve(() => new Response(null, { status: 200, headers: { 'content-length': '2400000' } }));

		const { images } = await probeResources([], ['https://cdn.example/hero.jpg']);

		expect(images[0]).toEqual({
			url: 'https://cdn.example/hero.jpg',
			status: 'ok',
			httpStatus: 200,
			bytes: 2_400_000,
		});
	});

	it('measures the body when no length is declared, up to the cap', async () => {
		serve((url, method) => {
			if (method === 'HEAD') return new Response(null, { status: 200 });
			const size = url.includes('huge') ? IMAGE_MEASURE_CAP_BYTES + 10 : 1234;
			return new Response(new Uint8Array(size), { status: 200 });
		});

		const { images } = await probeResources(
			[],
			['https://cdn.example/small.png', 'https://cdn.example/huge.png']
		);

		expect(images[0]).toMatchObject({ status: 'ok', bytes: 1234 });
		expect(images[0]!.bytesAtLeast).toBeUndefined();
		expect(images[1]).toMatchObject({ bytes: IMAGE_MEASURE_CAP_BYTES, bytesAtLeast: true });
	});

	it('reports a missing image without measuring it', async () => {
		serve(() => new Response(null, { status: 404 }));

		const { images } = await probeResources([], ['https://cdn.example/missing.png']);

		expect(images[0]).toEqual({
			url: 'https://cdn.example/missing.png',
			status: 'broken',
			httpStatus: 404,
		});
	});
});
