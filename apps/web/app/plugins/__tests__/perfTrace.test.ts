import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The local performance trace end to end, with no PostHog key configured:
 * off unless this browser opted in, bounded and clearable when it did, and an
 * export that carries route names and numbers but none of the personal data a
 * caller (or the URL) could have handed it. Nothing goes over the network.
 */

type Guard = (to: { name: unknown }, from: unknown, failure?: unknown) => void;

const ROUTES = ['dashboard', 'dashboard-postbox-folder', 'auth-login'];

const SENTINELS = [
	'jane.doe@example.com',
	'Quarterly salary review',
	'https://owlat.example/dashboard/postbox/inbox/jd7f3k2m9q8w1e4r5t6y7u8i9o0p1a2s',
	'jd7f3k2m9q8w1e4r5t6y7u8i9o0p1a2s',
	'Bearer eyJhbGciOiJIUzI1NiJ9',
];

let guards: Guard[];
let observers: number;
let deliverLongTasks: (durations: number[]) => void;
let currentRouteName: unknown;

class FakeObserver {
	static supportedEntryTypes = ['longtask'];
	constructor(private readonly callback: (list: { getEntries(): unknown[] }) => void) {
		observers += 1;
	}
	observe(options: { type: string }) {
		if (options.type !== 'longtask') return;
		deliverLongTasks = (durations) =>
			this.callback({
				getEntries: () =>
					durations.map((duration) => ({
						duration,
						attribution: [{ containerSrc: SENTINELS[2] }],
					})),
			});
	}
	disconnect() {}
	takeRecords() {
		return [];
	}
}

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
				return { name: currentRouteName };
			},
		},
	}));
	vi.resetModules();
	const plugin = (await import('../perf-trace.client')).default as unknown as () => void;
	const telemetry = await import('~/lib/perfTelemetry');
	return { plugin, telemetry };
}

function navigate(name: unknown) {
	currentRouteName = name;
	for (const guard of guards) guard({ name }, {});
}

describe('perf-trace plugin', () => {
	const network = vi.fn();

	beforeEach(() => {
		guards = [];
		observers = 0;
		deliverLongTasks = () => {};
		currentRouteName = 'dashboard';
		localStorage.clear();
		delete window.owlatPerfTrace;
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
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
		const trace = JSON.parse(handle.export());

		expect(trace.samples).toHaveLength(10);
		expect(trace.recorded).toBe(31);
		expect(trace.samples.at(-1)).toEqual({
			t: 150,
			event: 'owlat_reader_open_ms',
			route: 'dashboard-postbox-folder',
			values: { duration_ms: 29 },
		});

		handle.clear();
		const cleared = JSON.parse(handle.export());
		expect(cleared.samples).toEqual([]);
		expect(cleared.recorded).toBe(0);
		expect(cleared.summary).toEqual([]);
		expect(cleared.longTasks).toEqual([]);
		expect(network).not.toHaveBeenCalled();
	});

	it('samples the shared subscription counts on every settled navigation', async () => {
		localStorage.setItem('owlat:perf-trace', 'on');
		const { plugin } = await loadPlugin();
		plugin();

		navigate('dashboard');
		for (const guard of guards) guard({ name: 'auth-login' }, {}, new Error('aborted'));
		const trace = JSON.parse(window.owlatPerfTrace!.export());

		expect(trace.samples).toEqual([
			{
				t: 0,
				event: 'owlat_subscriptions',
				route: 'dashboard',
				values: { active_count: 0, lingering_count: 0, lingering_body_count: 0 },
			},
		]);
		expect(trace.subscriptions).toEqual({ active: 0, lingering: 0, lingeringBody: 0 });
	});

	it('exports and downloads no personal data, URLs, ids or credentials', async () => {
		localStorage.setItem('owlat:perf-trace', 'on');
		const { plugin, telemetry } = await loadPlugin();
		plugin();

		// A route the router does not know (a URL leaked into a name) and a
		// caller handing in every kind of string.
		navigate(SENTINELS[2]);
		telemetry.reportPerf('owlat_reader_open_ms', {
			duration_ms: 88,
			subject: SENTINELS[1]!,
			from: SENTINELS[0]!,
			messageId: SENTINELS[3]!,
			authorization: SENTINELS[4]!,
			landing_route: SENTINELS[0]!,
		});
		deliverLongTasks([120, 64]);

		let blob: Blob | null = null;
		vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => {
			blob = value as Blob;
			return 'blob:owlat-perf-trace';
		});
		const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
		const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
		window.owlatPerfTrace!.download();
		vi.runAllTimers();

		const exported = window.owlatPerfTrace!.export();
		const downloaded = await (blob as Blob | null)!.text();
		expect(click).toHaveBeenCalledTimes(1);
		expect(revoke).toHaveBeenCalledWith('blob:owlat-perf-trace');
		expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe(
			'owlat-perf-trace-0.7.0.json'
		);
		expect(downloaded).toBe(exported);
		for (const sentinel of SENTINELS) expect(exported).not.toContain(sentinel);
		expect(exported).not.toMatch(/@|https?:|\/dashboard/);

		const trace = JSON.parse(exported);
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
