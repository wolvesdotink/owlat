/**
 * Process metrics and event-loop stall detection for the long-running Node
 * services.
 *
 * NODE-ONLY: reads `node:perf_hooks` and pulls in `prom-client`. Exposed via the
 * `@owlat/shared/nodeMetrics` subpath ONLY — it must never be re-exported from
 * the `.` barrel, which has to stay browser-safe.
 *
 * Two independent halves, both owned by one {@link startNodeMetrics} call:
 *
 *  - A Prometheus registry holding prom-client's default process metrics (CPU,
 *    resident memory, heap, GC, open handles, event-loop lag) plus a stall
 *    counter. Rendered on demand by the service's `/metrics` route.
 *  - A stall sampler that writes ONE warning line when the event loop was
 *    blocked for longer than a threshold. It does not depend on anything
 *    scraping `/metrics`: most installs never run Prometheus, and the log line
 *    is what reaches them.
 *
 * The sampler uses its own `monitorEventLoopDelay` histogram. prom-client's
 * default lag gauges reset THEIR histogram on every scrape, so sharing one would
 * make the stall check see only the time since the last scrape.
 *
 * A blocked loop can only log once it runs again: a stall is reported when it
 * ends, and a loop that never unblocks reports nothing. The container
 * healthcheck is what catches that case. Node also drops the first gap after
 * the histogram is enabled or reset, so a stall that starts within one
 * resolution period (20 ms) of a window boundary can go unreported.
 */

import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { collectDefaultMetrics, Counter, Registry } from 'prom-client';
import { logEventBindings } from './logEvent';

/** What a `/metrics` route needs: the exposition format and its content type. */
export interface MetricsSource {
	readonly contentType: string;
	metrics(): Promise<string>;
}

/** The subset of a pino logger the stall line is written to. */
export interface StallLogger {
	warn(obj: object, msg: string): void;
}

/** One sampling window, as read from the event loop. */
export interface EventLoopReadings {
	/** Longest gap between two histogram wakeups in the window, in nanoseconds. */
	readonly delayMaxNs: number;
	/** Time the loop spent running callbacks (not idle in poll) in the window, in ms. */
	readonly activeMs: number;
	/** Wall time the window covers, in ms. */
	readonly elapsedMs: number;
}

/** Reads and resets one sampling window. */
export interface EventLoopSampler {
	/** Readings since the previous call (or since creation), then starts a new window. */
	sample(): EventLoopReadings;
	/** Releases the native timer behind the histogram. */
	stop(): void;
}

/**
 * Node's delay histogram wakes a native timer every resolution period and
 * records the gap between wakeups, so an idle loop reads about the resolution
 * and a stall of S reads between S and S + resolution.
 */
const SAMPLER_RESOLUTION_MS = 20;

const DEFAULT_STALL_THRESHOLD_MS = 1_000;

const DEFAULT_SAMPLE_INTERVAL_MS = 10_000;

const STALL_COUNTER_NAME = 'nodejs_eventloop_stalls_total';

/**
 * The real sampler, or `null` where the runtime has no delay histogram (Bun
 * throws ERR_NOT_IMPLEMENTED), in which case stall detection is off and the
 * registry still serves the remaining default metrics.
 */
function createEventLoopSampler(): EventLoopSampler | null {
	let histogram: ReturnType<typeof monitorEventLoopDelay>;
	try {
		histogram = monitorEventLoopDelay({ resolution: SAMPLER_RESOLUTION_MS });
	} catch {
		return null;
	}
	histogram.enable();
	let utilization = performance.eventLoopUtilization();
	return {
		sample() {
			const next = performance.eventLoopUtilization();
			const window = performance.eventLoopUtilization(next, utilization);
			// `max` is 0 until the histogram has recorded its first gap.
			const readings = {
				delayMaxNs: histogram.max,
				activeMs: window.active,
				elapsedMs: window.idle + window.active,
			};
			histogram.reset();
			utilization = next;
			return readings;
		},
		stop() {
			histogram.disable();
		},
	};
}

/**
 * The stall in a window in whole ms, or `undefined` when there was none.
 *
 * The resolution is subtracted, so a stall can be undercounted by up to one
 * resolution period. A window whose loop was mostly idle is not a stall even
 * with a long gap: libuv's clock keeps running while the host is suspended
 * (a laptop running `bun dev` goes to sleep), and that time is spent idle in
 * poll, not in a callback.
 */
function stallMs(
	readings: EventLoopReadings,
	thresholdMs: number = DEFAULT_STALL_THRESHOLD_MS
): number | undefined {
	const delayMs = Math.round(readings.delayMaxNs / 1e6) - SAMPLER_RESOLUTION_MS;
	if (delayMs < thresholdMs || readings.activeMs < delayMs) return undefined;
	return delayMs;
}

export interface NodeMetricsOptions {
	/** Where the stall line goes. */
	log: StallLogger;
	/** A gap at least this long is a stall. Default 1 s. */
	stallThresholdMs?: number;
	/**
	 * How often the stall sampler reads its window. One window logs at most one
	 * line, so this also bounds the log rate while the loop stays saturated.
	 * Default 10 s.
	 */
	sampleIntervalMs?: number;
	/**
	 * Test seam: the sampler to read. Defaults to {@link createEventLoopSampler};
	 * `null` turns stall detection off.
	 */
	sampler?: EventLoopSampler | null;
}

export interface NodeMetrics {
	/** The service's registry; serve it from `/metrics`. */
	readonly registry: Registry;
	/**
	 * Stops the stall sampler. The registry keeps answering, so a scrape during
	 * the shutdown drain still works. prom-client's own default collectors keep
	 * their (unref'd) native hooks until the process exits.
	 */
	stop(): void;
}

/**
 * Start process metrics and stall detection for one service process.
 *
 * Each call owns a fresh registry, so two instances (tests, or two servers in
 * one process) never collide on a metric name. Call it once per process in
 * production: the default collectors each install a native hook.
 */
export function startNodeMetrics(options: NodeMetricsOptions): NodeMetrics {
	const thresholdMs = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
	const intervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
	const registry = new Registry();
	collectDefaultMetrics({ register: registry });
	const stalls = new Counter({
		name: STALL_COUNTER_NAME,
		help: `Event-loop stalls of at least ${thresholdMs} ms, counted when the loop runs again`,
		registers: [registry],
	});

	const sampler = options.sampler === undefined ? createEventLoopSampler() : options.sampler;
	if (!sampler) return { registry, stop: () => {} };

	const tick = () => {
		const readings = sampler.sample();
		const delayMs = stallMs(readings, thresholdMs);
		if (delayMs === undefined) return;
		stalls.inc();
		const memory = process.memoryUsage();
		options.log.warn(
			{
				event: 'runtime.event_loop.stalled',
				...logEventBindings({
					durationMs: delayMs,
					detail: {
						thresholdMs,
						utilization:
							readings.elapsedMs > 0
								? Math.round((readings.activeMs / readings.elapsedMs) * 100) / 100
								: undefined,
						rssMb: Math.round(memory.rss / 1024 / 1024),
						heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
					},
				}),
			},
			`event loop stalled for ${delayMs} ms`
		);
	};
	const timer = setInterval(tick, intervalMs);
	// Sampling must never be what keeps a draining process alive.
	timer.unref();

	let stopped = false;
	return {
		registry,
		stop() {
			if (stopped) return;
			stopped = true;
			clearInterval(timer);
			sampler.stop();
		},
	};
}
