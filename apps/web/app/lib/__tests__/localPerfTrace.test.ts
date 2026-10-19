import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createLocalPerfTrace,
	DEFAULT_TRACE_LIMIT,
	LOCAL_PERF_TRACE_KEY,
	MAX_TRACE_LIMIT,
	MIN_TRACE_LIMIT,
	observeLongTasks,
	readLocalPerfTraceLimit,
	type SubscriptionCounts,
} from '../localPerfTrace';

const BUILD = {
	version: '0.7.0',
	gitSha: 'abc1234',
	buildDate: '2026-10-19',
	deploymentMode: 'selfhost',
	desktop: false,
};

const ROUTES = new Set(['dashboard', 'dashboard-postbox-folder', 'auth-login']);

function storageWith(value: string | null): Pick<Storage, 'getItem'> {
	return { getItem: (key) => (key === LOCAL_PERF_TRACE_KEY ? value : null) };
}

function makeTrace(limit: number, counts?: () => SubscriptionCounts) {
	let clock = 0;
	const trace = createLocalPerfTrace({
		limit,
		build: BUILD,
		knownRoutes: ROUTES,
		now: () => (clock += 10),
		subscriptionCounts: counts,
	});
	return trace;
}

describe('readLocalPerfTraceLimit', () => {
	it('is off without the key, with an empty one, or with anything unexpected', () => {
		expect(readLocalPerfTraceLimit(undefined)).toBeNull();
		expect(readLocalPerfTraceLimit(storageWith(null))).toBeNull();
		expect(readLocalPerfTraceLimit(storageWith(''))).toBeNull();
		expect(readLocalPerfTraceLimit(storageWith('off'))).toBeNull();
		expect(readLocalPerfTraceLimit(storageWith('-5'))).toBeNull();
		expect(readLocalPerfTraceLimit(storageWith('12.5'))).toBeNull();
	});

	it('is off when storage throws (a blocked localStorage)', () => {
		const throwing = {
			getItem: () => {
				throw new Error('SecurityError');
			},
		};
		expect(readLocalPerfTraceLimit(throwing)).toBeNull();
	});

	it('keeps the default for "on" and clamps a number into range', () => {
		expect(readLocalPerfTraceLimit(storageWith('on'))).toBe(DEFAULT_TRACE_LIMIT);
		expect(readLocalPerfTraceLimit(storageWith(' ON '))).toBe(DEFAULT_TRACE_LIMIT);
		expect(readLocalPerfTraceLimit(storageWith('1'))).toBe(DEFAULT_TRACE_LIMIT);
		expect(readLocalPerfTraceLimit(storageWith('200'))).toBe(200);
		expect(readLocalPerfTraceLimit(storageWith('2'))).toBe(MIN_TRACE_LIMIT);
		expect(readLocalPerfTraceLimit(storageWith('999999'))).toBe(MAX_TRACE_LIMIT);
	});
});

describe('createLocalPerfTrace', () => {
	it('keeps at most its bound, newest samples, oldest first', () => {
		const trace = makeTrace(10);
		for (let i = 0; i < 25; i += 1) {
			trace.record('owlat_boot_shell_ms', { route: 'dashboard', duration_ms: i });
		}
		const snapshot = trace.snapshot();

		expect(snapshot.samples).toHaveLength(10);
		expect(snapshot.samples.map((s) => s.values['duration_ms'])).toEqual([
			15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
		]);
		expect(snapshot.recorded).toBe(25);
		expect(snapshot.overwritten).toBe(15);
		expect(snapshot.limit).toBe(10);
	});

	it('never grows past its bound however long the tab stays open', () => {
		const trace = makeTrace(MIN_TRACE_LIMIT);
		for (let i = 0; i < 10_000; i += 1) {
			trace.record('owlat_reader_open_ms', { route: 'dashboard', duration_ms: i % 97 });
			trace.recordLongTask('dashboard', 60);
		}
		const snapshot = trace.snapshot();
		expect(snapshot.samples).toHaveLength(MIN_TRACE_LIMIT);
		expect(snapshot.longTasks).toEqual([
			{ route: 'dashboard', count: 10_000, total_ms: 600_000, max_ms: 60 },
		]);
	});

	it('clears completely', () => {
		const trace = makeTrace(10);
		for (let i = 0; i < 15; i += 1) trace.record('owlat_boot_shell_ms', { duration_ms: i });
		trace.record('not-an-owlat-event', { duration_ms: 1 });
		trace.recordLongTask('dashboard', 80);

		trace.clear();
		const snapshot = trace.snapshot();

		expect(snapshot.samples).toEqual([]);
		expect(snapshot.summary).toEqual([]);
		expect(snapshot.longTasks).toEqual([]);
		expect([snapshot.recorded, snapshot.overwritten, snapshot.rejected]).toEqual([0, 0, 0]);

		// And it keeps working, from an empty ring, after a clear.
		trace.record('owlat_boot_shell_ms', { route: 'dashboard', duration_ms: 7 });
		expect(trace.snapshot().samples.map((s) => s.values['duration_ms'])).toEqual([7]);
	});

	it('summarizes the buffered timings per event, route and metric', () => {
		const trace = makeTrace(100);
		for (const duration of [40, 10, 30, 20, 100]) {
			trace.record('owlat_reader_open_ms', {
				route: 'dashboard-postbox-folder',
				duration_ms: duration,
			});
		}
		trace.record('owlat_reader_open_ms', { route: 'dashboard', duration_ms: 5 });

		expect(trace.snapshot().summary).toEqual([
			{
				event: 'owlat_reader_open_ms',
				route: 'dashboard-postbox-folder',
				metric: 'duration_ms',
				count: 5,
				min: 10,
				max: 100,
				mean: 40,
				p50: 30,
				p95: 100,
			},
			{
				event: 'owlat_reader_open_ms',
				route: 'dashboard',
				metric: 'duration_ms',
				count: 1,
				min: 5,
				max: 5,
				mean: 5,
				p50: 5,
				p95: 5,
			},
		]);
	});

	it('carries the build metadata and the current subscription counts', () => {
		const trace = makeTrace(10, () => ({ active: 4, lingering: 2, lingeringBody: 1 }));
		const exported = JSON.parse(trace.export());

		expect(exported.format).toBe('owlat-perf-trace/1');
		expect(exported.build).toEqual(BUILD);
		expect(exported.subscriptions).toEqual({ active: 4, lingering: 2, lingeringBody: 1 });
	});

	it('keeps a web vitals sample whole, landing route included', () => {
		const trace = makeTrace(10);
		trace.record('owlat_web_vitals', {
			route: 'dashboard',
			landing_route: 'auth-login',
			lcp_ms: 812,
			inp_ms: 64,
			cls: 0.01234,
		});

		expect(trace.snapshot().samples).toEqual([
			{
				t: 10,
				event: 'owlat_web_vitals',
				route: 'dashboard',
				landing_route: 'auth-login',
				values: { lcp_ms: 812, inp_ms: 64, cls: 0.0123 },
			},
		]);
	});

	describe('privacy sentinels', () => {
		const SENTINELS = [
			'jane.doe@example.com',
			'Quarterly salary review',
			'https://owlat.example/dashboard/postbox/inbox/jd7f3k2m9q8w1e4r5t6y7u8i9o0p1a2s',
			'/dashboard/postbox/inbox/jd7f3k2m9q8w1e4r5t6y7u8i9o0p1a2s',
			'jd7f3k2m9q8w1e4r5t6y7u8i9o0p1a2s',
			'sk-live-SECRETTOKEN',
			'Bearer eyJhbGciOiJIUzI1NiJ9',
			'Hello Jane, the contract is attached',
		];

		it('exports none of the strings a caller tried to hand in', () => {
			const trace = makeTrace(50);
			trace.record('owlat_reader_open_ms', {
				// Every string-valued field: the route keys get a URL, an id, an
				// address; the others carry subject, body and credentials.
				route: SENTINELS[2]!,
				landing_route: SENTINELS[0]!,
				subject: SENTINELS[1]!,
				url: SENTINELS[3]!,
				messageId: SENTINELS[4]!,
				token: SENTINELS[5]!,
				authorization: SENTINELS[6]!,
				body: SENTINELS[7]!,
				duration_ms: 120,
				// A number under a key that is itself the personal datum.
				'jane.doe@example.com': 1,
				jd7f3k2m9q8w1e4r5t6y7u8i9o0p1a2s: 2,
			});
			// Event names that are not `owlat_*` names are refused, sentinel or not.
			for (const sentinel of SENTINELS) trace.record(sentinel, { duration_ms: 1 });
			trace.record(`owlat_${SENTINELS[4]}@x`, { duration_ms: 1 });
			trace.recordLongTask(SENTINELS[2]!, 75);
			const json = trace.export();

			for (const sentinel of SENTINELS) expect(json).not.toContain(sentinel);
			expect(json).not.toMatch(/@|https?:|\/dashboard/);
			const { samples, rejected, longTasks } = JSON.parse(json);
			expect(samples).toEqual([
				{
					t: 10,
					event: 'owlat_reader_open_ms',
					route: 'unknown',
					landing_route: 'unknown',
					values: { duration_ms: 120 },
				},
			]);
			expect(rejected).toBe(SENTINELS.length + 1);
			expect(longTasks).toEqual([{ route: 'unknown', count: 1, total_ms: 75, max_ms: 75 }]);
		});

		it('drops numbers that are not finite and keys that name no unit', () => {
			const trace = makeTrace(10);
			trace.record('owlat_boot_shell_ms', {
				route: 'dashboard',
				duration_ms: Number.NaN,
				size_bytes: Number.POSITIVE_INFINITY,
				row_count: 12,
				userAge: 41,
				phone: 4915112345678,
			});
			expect(trace.snapshot().samples[0]?.values).toEqual({ row_count: 12 });
		});
	});
});

describe('observeLongTasks', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('does nothing where the browser has no long task entries', () => {
		const construct = vi.fn();
		class NoLongTasks {
			static supportedEntryTypes = ['event'];
			constructor() {
				construct();
			}
		}
		vi.stubGlobal('PerformanceObserver', NoLongTasks);
		const onTask = vi.fn();

		observeLongTasks(onTask)();

		expect(construct).not.toHaveBeenCalled();
		expect(onTask).not.toHaveBeenCalled();
	});

	it('reports each long task by its duration only, until disconnected', () => {
		let deliver: (entries: Array<Record<string, unknown>>) => void = () => {};
		const disconnect = vi.fn();
		class LongTaskObserver {
			static supportedEntryTypes = ['longtask'];
			constructor(callback: (list: { getEntries(): unknown[] }) => void) {
				deliver = (entries) => callback({ getEntries: () => entries });
			}
			observe() {}
			disconnect = disconnect;
		}
		vi.stubGlobal('PerformanceObserver', LongTaskObserver);
		const onTask = vi.fn();

		const stop = observeLongTasks(onTask);
		deliver([
			{
				duration: 73,
				name: 'self',
				attribution: [{ containerSrc: 'https://owlat.example/frame?id=jd7' }],
			},
		]);
		stop();

		expect(onTask.mock.calls).toEqual([[73]]);
		expect(disconnect).toHaveBeenCalledTimes(1);
	});
});
