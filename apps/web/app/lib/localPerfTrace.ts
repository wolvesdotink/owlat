/**
 * Local performance traces: the samples `lib/perfTelemetry` takes, kept in
 * this tab's memory instead of sent anywhere. A deployment without PostHog
 * gets the same evidence, and so does a developer who wants the numbers
 * without turning analytics on.
 *
 * Off unless this browser opts in: `localStorage['owlat:perf-trace']` set to
 * `on` (the default bound) or to a number of samples, then a reload. While it
 * is off nothing below runs: no buffer, no observer, no console handle.
 *
 * What a trace holds is decided here, not by the callers:
 *  - samples: an `owlat_*` event name, the route NAME it was taken on and its
 *    numeric properties, in a ring buffer of the configured size;
 *  - long tasks: a count, total and longest duration per route name;
 *  - the shared Convex subscription counts (active and lingering);
 *  - the build version, git sha and deployment mode.
 * Any other string a caller hands in (a URL, an id, an address, a subject) is
 * dropped before it is stored, a number survives only under a unit-suffixed
 * key, and a route value that is not one of the router's own names becomes
 * `unknown`. Nothing is sent: the trace leaves the tab only when someone
 * exports it from the console (`owlatPerfTrace.export()` / `.download()`).
 *
 * The bound is a memory limit, not a performance target.
 */
import type { PerfProperties } from '~/lib/perfTelemetry';

export const LOCAL_PERF_TRACE_KEY = 'owlat:perf-trace';
export const DEFAULT_TRACE_LIMIT = 500;
export const MIN_TRACE_LIMIT = 10;
export const MAX_TRACE_LIMIT = 5000;
export const TRACE_FORMAT = 'owlat-perf-trace/1';

/** The route the trace falls back to for anything that is not a route name. */
const UNKNOWN_ROUTE = 'unknown';
const EVENT_NAME = /^owlat_[a-z0-9_]{1,58}$/;
/** Numbers are kept only under keys that name a unit or a count, or `cls`. */
const METRIC_KEY = /^[a-z][a-z0-9_]{0,40}_(ms|count|bytes)$|^cls$/;

/**
 * The bound this browser asked for, or `null` when the trace is off. `on`
 * keeps the default; a number is clamped into the supported range; anything
 * else (including a storage that throws) is off.
 */
export function readLocalPerfTraceLimit(
	storage: Pick<Storage, 'getItem'> | null | undefined
): number | null {
	let raw: string | null;
	try {
		raw = storage?.getItem(LOCAL_PERF_TRACE_KEY) ?? null;
	} catch {
		return null;
	}
	const value = raw?.trim().toLowerCase();
	if (!value) return null;
	if (value === 'on' || value === 'true' || value === '1') return DEFAULT_TRACE_LIMIT;
	if (!/^\d+$/.test(value)) return null;
	return Math.min(MAX_TRACE_LIMIT, Math.max(MIN_TRACE_LIMIT, Number(value)));
}

export interface TraceBuild {
	version: string;
	gitSha: string;
	buildDate: string;
	deploymentMode: string;
	desktop: boolean;
}

export interface SubscriptionCounts {
	active: number;
	lingering: number;
	lingeringBody: number;
}

export interface TraceSample {
	/** Milliseconds since the page started (`performance.now()`), rounded. */
	t: number;
	event: string;
	route: string;
	landing_route?: string;
	values: Record<string, number>;
}

export interface TraceSummary {
	event: string;
	route: string;
	metric: string;
	count: number;
	min: number;
	max: number;
	mean: number;
	p50: number;
	p95: number;
}

export interface LongTaskSummary {
	route: string;
	count: number;
	total_ms: number;
	max_ms: number;
}

export interface LocalPerfTraceExport {
	format: typeof TRACE_FORMAT;
	build: TraceBuild;
	limit: number;
	/** Samples accepted since the last clear, including the overwritten ones. */
	recorded: number;
	/** Accepted samples the ring buffer has overwritten since the last clear. */
	overwritten: number;
	/** Samples refused because their event name is not an `owlat_*` name. */
	rejected: number;
	samples: TraceSample[];
	summary: TraceSummary[];
	longTasks: LongTaskSummary[];
	subscriptions: SubscriptionCounts | null;
}

export interface LocalPerfTrace {
	readonly limit: number;
	record(event: string, properties: PerfProperties): void;
	recordLongTask(route: string, durationMs: number): void;
	snapshot(): LocalPerfTraceExport;
	/** The snapshot as JSON, ready to save or paste. */
	export(): string;
	clear(): void;
}

function round(value: number, digits: number): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: number[], p: number): number {
	const rank = Math.ceil((p / 100) * sorted.length);
	return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

export function createLocalPerfTrace(options: {
	limit: number;
	build: TraceBuild;
	/** The router's own route names; any other route value becomes `unknown`. */
	knownRoutes: ReadonlySet<string>;
	now: () => number;
	subscriptionCounts?: () => SubscriptionCounts;
}): LocalPerfTrace {
	const limit = Math.min(MAX_TRACE_LIMIT, Math.max(MIN_TRACE_LIMIT, Math.floor(options.limit)));
	const build: TraceBuild = { ...options.build };
	let slots: TraceSample[] = [];
	let next = 0;
	let recorded = 0;
	let overwritten = 0;
	let rejected = 0;
	const longTasks = new Map<string, LongTaskSummary>();

	function routeOf(value: unknown): string {
		return typeof value === 'string' && options.knownRoutes.has(value) ? value : UNKNOWN_ROUTE;
	}

	function push(sample: TraceSample): void {
		recorded += 1;
		if (slots.length < limit) {
			slots.push(sample);
			return;
		}
		slots[next] = sample;
		next = (next + 1) % limit;
		overwritten += 1;
	}

	/** Oldest first. */
	function samples(): TraceSample[] {
		return slots.length < limit ? [...slots] : [...slots.slice(next), ...slots.slice(0, next)];
	}

	function summarize(list: TraceSample[]): TraceSummary[] {
		const groups = new Map<
			string,
			{ event: string; route: string; metric: string; values: number[] }
		>();
		for (const sample of list) {
			for (const [metric, value] of Object.entries(sample.values)) {
				const key = `${sample.event}\u0000${sample.route}\u0000${metric}`;
				let group = groups.get(key);
				if (!group) {
					group = { event: sample.event, route: sample.route, metric, values: [] };
					groups.set(key, group);
				}
				group.values.push(value);
			}
		}
		return [...groups.values()].map(({ event, route, metric, values }) => {
			const sorted = values.sort((a, b) => a - b);
			const total = sorted.reduce((sum, value) => sum + value, 0);
			return {
				event,
				route,
				metric,
				count: sorted.length,
				min: sorted[0]!,
				max: sorted.at(-1)!,
				mean: round(total / sorted.length, 4),
				p50: percentile(sorted, 50),
				p95: percentile(sorted, 95),
			};
		});
	}

	const trace: LocalPerfTrace = {
		limit,
		record(event, properties) {
			if (!EVENT_NAME.test(event)) {
				rejected += 1;
				return;
			}
			const values: Record<string, number> = {};
			for (const [key, value] of Object.entries(properties)) {
				if (typeof value !== 'number' || !Number.isFinite(value) || !METRIC_KEY.test(key)) continue;
				values[key] = round(value, 4);
			}
			const sample: TraceSample = {
				t: Math.round(options.now()),
				event,
				route: routeOf(properties['route']),
				values,
			};
			if ('landing_route' in properties)
				sample.landing_route = routeOf(properties['landing_route']);
			push(sample);
		},
		recordLongTask(route, durationMs) {
			if (!Number.isFinite(durationMs) || durationMs < 0) return;
			const name = routeOf(route);
			const summary = longTasks.get(name) ?? { route: name, count: 0, total_ms: 0, max_ms: 0 };
			summary.count += 1;
			summary.total_ms = round(summary.total_ms + durationMs, 1);
			summary.max_ms = round(Math.max(summary.max_ms, durationMs), 1);
			longTasks.set(name, summary);
		},
		snapshot() {
			const list = samples();
			return {
				format: TRACE_FORMAT,
				build: { ...build },
				limit,
				recorded,
				overwritten,
				rejected,
				samples: list,
				summary: summarize(list),
				longTasks: [...longTasks.values()].map((summary) => ({ ...summary })),
				subscriptions: options.subscriptionCounts ? { ...options.subscriptionCounts() } : null,
			};
		},
		export() {
			return JSON.stringify(trace.snapshot(), null, 2);
		},
		clear() {
			slots = [];
			next = 0;
			recorded = 0;
			overwritten = 0;
			rejected = 0;
			longTasks.clear();
		},
	};
	return trace;
}

/**
 * Report every long task (50 ms+ of main-thread work) by its duration only:
 * the entry's attribution names frames and script URLs, which a trace never
 * keeps. Returns the disconnect, a no-op where the browser has no long tasks.
 */
export function observeLongTasks(onTask: (durationMs: number) => void): () => void {
	if (typeof PerformanceObserver === 'undefined') return () => {};
	if (!(PerformanceObserver.supportedEntryTypes ?? []).includes('longtask')) return () => {};
	try {
		const observer = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) onTask(entry.duration);
		});
		observer.observe({ type: 'longtask', buffered: true });
		return () => observer.disconnect();
	} catch {
		return () => {};
	}
}
