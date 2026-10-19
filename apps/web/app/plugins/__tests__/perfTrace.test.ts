import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The local performance trace end to end, with no PostHog key configured:
 * off unless this browser opted in, bounded and clearable when it did, and an
 * export that carries route names and numbers but none of the personal data a
 * caller (or the URL) could have handed it. Nothing goes over the network.
 */

type Guard = (to: { name: unknown; fullPath: string }, from: unknown, failure?: unknown) => void;
type EntryFeed = (entries: Array<Record<string, unknown>>) => void;

const ROUTES = ['dashboard', 'dashboard-postbox-folder', 'auth-login'];

const SENTINELS = [
	'jane.doe@example.com',
	'Quarterly salary review',
	'https://owlat.example/dashboard/postbox/inbox/jd7f3k2m9q8w1e4r5t6y7u8i9o0p1a2s',
	'jd7f3k2m9q8w1e4r5t6y7u8i9o0p1a2s',
	'Bearer eyJhbGciOiJIUzI1NiJ9',
];

let guards: Guard[];
let hooks: Map<string, Array<() => void>>;
let observers: number;
let feeds: Map<string, EntryFeed>;
let currentRoute: { name: unknown; fullPath: string };

class FakeObserver {
	static supportedEntryTypes = ['longtask', 'largest-contentful-paint', 'layout-shift', 'event'];
	constructor(private readonly callback: (list: { getEntries(): unknown[] }) => void) {
		observers += 1;
	}
	observe(options: { type: string }) {
		feeds.set(options.type, (entries) => this.callback({ getEntries: () => entries }));
	}
	disconnect() {}
	takeRecords() {
		return [];
	}
}

function feed(type: string, entries: Array<Record<string, unknown>>) {
	feeds.get(type)?.(entries);
}

const fakeNuxtApp = {
	hook(name: string, fn: () => void) {
		hooks.set(name, [...(hooks.get(name) ?? []), fn]);
		return () => {};
	},
};

async function loadPlugin() {
	vi.stubGlobal('defineNuxtPlugin', (def: unknown) => def);
	vi.stubGlobal('useRuntimeConfig', () => ({
		public: {
			posthogApiKey: '',
			owlatVersion: '0.7.0',
			owlatGitSha: 'abc1234',
			owlatBuildDate: '2026-10-19',
			deploymentMode: 'selfhost',
			isDesktopBuild: false,
		},
	}));
	vi.stubGlobal('useRouter', () => ({
		getRoutes: () => ROUTES.map((name) => ({ name })),
		afterEach: (guard: Guard) => {
			guards.push(guard);
			return () => {};
		},
		currentRoute: {
			get value() {
				return currentRoute;
			},
		},
	}));
	vi.resetModules();
	const definition = (await import('../perf-trace.client')).default as unknown as (
		nuxtApp: typeof fakeNuxtApp
	) => void;
	// Same module registry as the plugin: loaded right after the reset.
	const telemetry = await import('~/lib/perfTelemetry');
	const registry = await import('~/lib/sharedConvexSubscriptions');
	return { plugin: () => definition(fakeNuxtApp), telemetry, registry };
}

function callHook(name: string) {
	for (const fn of hooks.get(name) ?? []) fn();
}

/**
 * A navigation as Nuxt 4.5 runs it: on success the route changes; on a
 * failure (aborted, cancelled, duplicated) it does not, and the router plugin
 * calls `page:loading:end` from its own `afterEach`.
 */
function navigate(name: unknown, options: { failure?: unknown; query?: string } = {}) {
	const to = { name, fullPath: `/${String(name)}${options.query ?? ''}` };
	if (!options.failure) currentRoute = to;
	for (const guard of guards) guard(to, {}, options.failure);
	if (options.failure) callHook('page:loading:end');
}

/** The destination's page Suspense resolved: Nuxt calls `page:finish`, then `page:loading:end`. */
function pageRendered() {
	callHook('page:finish');
	callHook('page:loading:end');
}

/** A re-render that kept the page (same page key): Nuxt calls `page:loading:end` only. */
function samePageRendered() {
	callHook('page:loading:end');
}

function nextFrame() {
	vi.advanceTimersByTime(16);
}

function exported() {
	return JSON.parse(window.owlatPerfTrace!.export());
}

type Registry = Awaited<ReturnType<typeof loadPlugin>>['registry'];

/** A page component's query: opened on mount, released (to linger) on unmount. */
function holdQuery(registry: Registry, key: string): () => void {
	return registry.openShared(key, {}, () => () => {}, { update: () => {}, fail: () => {} }, false);
}

describe('perf-trace plugin', () => {
	const network = vi.fn();

	beforeEach(() => {
		guards = [];
		hooks = new Map();
		observers = 0;
		feeds = new Map();
		currentRoute = { name: 'dashboard', fullPath: '/dashboard' };
		localStorage.clear();
		delete window.owlatPerfTrace;
		vi.useFakeTimers({
			toFake: [
				'setTimeout',
				'clearTimeout',
				'requestAnimationFrame',
				'cancelAnimationFrame',
				'performance',
			],
		});
		vi.stubGlobal('PerformanceObserver', FakeObserver);
		vi.stubGlobal('fetch', network);
		vi.stubGlobal('XMLHttpRequest', network);
		vi.spyOn(console, 'info').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		network.mockReset();
	});

	it('does nothing at all unless this browser opted in', async () => {
		const { plugin, telemetry } = await loadPlugin();
		plugin();
		telemetry.reportPerf('owlat_boot_shell_ms', { duration_ms: 300 });

		expect(window.owlatPerfTrace).toBeUndefined();
		expect(guards).toEqual([]);
		expect(hooks.size).toBe(0);
		expect(observers).toBe(0);
		expect(console.info).not.toHaveBeenCalled();
	});

	it('stays off for a value it does not understand', async () => {
		localStorage.setItem('owlat:perf-trace', 'please');
		const { plugin } = await loadPlugin();
		plugin();

		expect(window.owlatPerfTrace).toBeUndefined();
		expect(observers).toBe(0);
	});

	it('records samples without PostHog, within the bound, and clears completely', async () => {
		localStorage.setItem('owlat:perf-trace', '10');
		const { plugin, telemetry } = await loadPlugin();
		plugin();
		const handle = window.owlatPerfTrace!;
		expect(handle.limit).toBe(10);

		navigate('dashboard-postbox-folder');
		for (let i = 0; i < 30; i += 1) {
			vi.advanceTimersByTime(5);
			telemetry.reportPerf('owlat_reader_open_ms', { duration_ms: i });
		}
		const trace = exported();

		expect(trace.samples).toHaveLength(10);
		expect(trace.recorded).toBe(30);
		expect(trace.samples.at(-1)).toEqual({
			t: 150,
			event: 'owlat_reader_open_ms',
			route: 'dashboard-postbox-folder',
			values: { duration_ms: 29 },
		});

		handle.clear();
		const cleared = exported();
		expect(cleared.samples).toEqual([]);
		expect(cleared.recorded).toBe(0);
		expect(cleared.summary).toEqual([]);
		expect(cleared.longTasks).toEqual([]);
		expect(network).not.toHaveBeenCalled();
	});

	describe('subscription samples', () => {
		it('counts after the destination rendered and the page before let go', async () => {
			localStorage.setItem('owlat:perf-trace', 'on');
			const { plugin, registry } = await loadPlugin();
			plugin();
			const leaveA = holdQuery(registry, 'page-a');

			navigate('dashboard-postbox-folder');
			// The old page is still leaving (out-in transition): nothing yet.
			nextFrame();
			expect(exported().samples).toEqual([]);

			// It unmounts, the new page mounts two queries, Nuxt reports the render.
			leaveA();
			holdQuery(registry, 'page-b-1');
			holdQuery(registry, 'page-b-2');
			pageRendered();
			expect(exported().samples).toEqual([]);
			nextFrame();

			expect(exported().samples).toEqual([
				{
					t: 32,
					event: 'owlat_subscriptions',
					route: 'dashboard-postbox-folder',
					values: { active_count: 2, lingering_count: 1, lingering_body_count: 0 },
				},
			]);
			expect(exported().subscriptions).toEqual({ active: 2, lingering: 1, lingeringBody: 0 });

			// One sample per navigation: a later render of the same page adds none.
			pageRendered();
			nextFrame();
			expect(exported().samples).toHaveLength(1);
		});

		it('drops a sample a newer navigation superseded before the render finished', async () => {
			localStorage.setItem('owlat:perf-trace', 'on');
			const { plugin } = await loadPlugin();
			plugin();

			navigate('dashboard-postbox-folder');
			navigate('auth-login');
			pageRendered();
			nextFrame();

			expect(exported().samples.map((s: { route: string }) => s.route)).toEqual(['auth-login']);
		});

		it('drops a sample a newer navigation superseded during its last frame', async () => {
			localStorage.setItem('owlat:perf-trace', 'on');
			const { plugin } = await loadPlugin();
			plugin();

			navigate('dashboard-postbox-folder');
			pageRendered();
			navigate('auth-login');
			nextFrame();
			expect(exported().samples).toEqual([]);

			pageRendered();
			nextFrame();
			expect(exported().samples.map((s: { route: string }) => s.route)).toEqual(['auth-login']);
		});

		it('takes none for a failed navigation', async () => {
			localStorage.setItem('owlat:perf-trace', 'on');
			const { plugin } = await loadPlugin();
			plugin();

			navigate('auth-login', { failure: new Error('aborted') });
			nextFrame();
			pageRendered();
			nextFrame();

			expect(exported().samples).toEqual([]);
		});

		it('records nothing wrong when the navigation is repeated while it renders', async () => {
			localStorage.setItem('owlat:perf-trace', 'on');
			const { plugin, registry } = await loadPlugin();
			plugin();
			const leaveA = holdQuery(registry, 'page-a');

			navigate('dashboard-postbox-folder');
			// The same link again before the page rendered: a duplicated
			// navigation, whose failure makes Nuxt call `page:loading:end`.
			navigate('dashboard-postbox-folder', { failure: { type: 16 } });
			nextFrame();
			expect(exported().samples).toEqual([]);

			leaveA();
			holdQuery(registry, 'page-b-1');
			holdQuery(registry, 'page-b-2');
			pageRendered();
			nextFrame();

			// No `active 1, lingering 0` under the destination: the failure
			// cancelled the pending sample, so this navigation takes none.
			expect(exported().samples).toEqual([]);
		});

		it('ignores page:loading:end on its own, as a same-page re-render sends it', async () => {
			localStorage.setItem('owlat:perf-trace', 'on');
			const { plugin, registry } = await loadPlugin();
			plugin();
			holdQuery(registry, 'page-a');

			// A query-only change keeps the page mounted: no Suspense, no sample.
			navigate('dashboard', { query: '?filter=unread' });
			samePageRendered();
			nextFrame();
			expect(exported().samples).toEqual([]);

			navigate('auth-login');
			samePageRendered();
			nextFrame();
			expect(exported().samples).toEqual([]);
			pageRendered();
			nextFrame();
			expect(exported().samples.map((s: { route: string }) => s.route)).toEqual(['auth-login']);
		});

		it('takes none when the route moved on without a navigation of its own', async () => {
			localStorage.setItem('owlat:perf-trace', 'on');
			const { plugin } = await loadPlugin();
			plugin();

			navigate('dashboard-postbox-folder');
			currentRoute = { name: 'dashboard-postbox-folder', fullPath: '/elsewhere' };
			pageRendered();
			nextFrame();

			expect(exported().samples).toEqual([]);
		});
	});

	it("keeps every listed producer's event with all of its numbers", async () => {
		localStorage.setItem('owlat:perf-trace', 'on');
		const { plugin, telemetry } = await loadPlugin();
		plugin();
		const { usePerfMark } = await import('~/composables/usePerfMark');
		vi.useRealTimers();

		// The real producers: the span timings, the web vitals, the subscriptions.
		const { mark, measure, measureBoot } = usePerfMark();
		measureBoot('owlat_boot_shell_ms');
		mark('owlat_reader_open_start');
		measure('owlat_reader_open_ms', 'owlat_reader_open_start');
		mark('owlat_back_list_start');
		measure('owlat_back_list_ms', 'owlat_back_list_start');
		feed('largest-contentful-paint', [{ startTime: 812 }]);
		feed('layout-shift', [{ value: 0.02, hadRecentInput: false, startTime: 100 }]);
		feed('event', [{ interactionId: 7, duration: 48 }]);
		window.dispatchEvent(new Event('pagehide'));
		navigate('dashboard');
		pageRendered();
		await new Promise((resolve) => requestAnimationFrame(resolve));

		const samples: Array<{ event: string; values: Record<string, number> }> = exported().samples;
		for (const [event, keys] of Object.entries(telemetry.PERF_EVENTS)) {
			const sample = samples.find((s) => s.event === event);
			expect(sample, event).toBeDefined();
			expect(Object.keys(sample!.values).sort(), event).toEqual([...keys].sort());
		}
		expect(samples).toHaveLength(Object.keys(telemetry.PERF_EVENTS).length);
	});

	it('exports and downloads no personal data, URLs, ids or credentials', async () => {
		localStorage.setItem('owlat:perf-trace', 'on');
		const { plugin, telemetry } = await loadPlugin();
		plugin();

		// A route the router does not know (a URL leaked into a name) and a
		// caller that slipped past the types with every kind of string.
		navigate(SENTINELS[2]);
		const hostile: Record<string, unknown> = {
			duration_ms: 88,
			subject: SENTINELS[1],
			from: SENTINELS[0],
			messageId: SENTINELS[3],
			authorization: SENTINELS[4],
			landing_route: SENTINELS[0],
			[`${SENTINELS[3]}_ms`]: 1,
		};
		telemetry.reportPerf('owlat_reader_open_ms', hostile as never);
		feed('longtask', [
			{ duration: 120, attribution: [{ containerSrc: SENTINELS[2] }] },
			{ duration: 64, attribution: [{ containerSrc: SENTINELS[2] }] },
		]);

		let blob: Blob | null = null;
		vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => {
			blob = value as Blob;
			return 'blob:owlat-perf-trace';
		});
		const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
		const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
		window.owlatPerfTrace!.download();
		vi.runAllTimers();

		const json = window.owlatPerfTrace!.export();
		const downloaded = await (blob as Blob | null)!.text();
		expect(click).toHaveBeenCalledTimes(1);
		expect(revoke).toHaveBeenCalledWith('blob:owlat-perf-trace');
		expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe(
			'owlat-perf-trace-0.7.0.json'
		);
		expect(downloaded).toBe(json);
		for (const sentinel of SENTINELS) expect(json).not.toContain(sentinel);
		expect(json).not.toMatch(/@|https?:|\/dashboard/);

		const trace = JSON.parse(json);
		expect(trace.samples.at(-1)).toEqual({
			t: 0,
			event: 'owlat_reader_open_ms',
			route: 'unknown',
			landing_route: 'unknown',
			values: { duration_ms: 88 },
		});
		expect(trace.longTasks).toEqual([{ route: 'unknown', count: 2, total_ms: 184, max_ms: 120 }]);
		expect(trace.build).toEqual({
			version: '0.7.0',
			gitSha: 'abc1234',
			buildDate: '2026-10-19',
			deploymentMode: 'selfhost',
			desktop: false,
		});
		expect(network).not.toHaveBeenCalled();
	});
});
