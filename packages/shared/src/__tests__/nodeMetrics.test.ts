import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	startNodeMetrics,
	type EventLoopReadings,
	type EventLoopSampler,
	type NodeMetrics,
} from '../nodeMetrics';

const MS = 1e6;

/** A quiet 10 s window: the loop woke on time and was mostly idle. */
const QUIET: EventLoopReadings = { delayMaxNs: 25 * MS, activeMs: 300, elapsedMs: 10_000 };

function scriptedSampler(windows: EventLoopReadings[]) {
	const sampler = {
		sample: vi.fn(() => windows.shift() ?? QUIET),
		stop: vi.fn(),
	} satisfies EventLoopSampler;
	return sampler;
}

async function stallCount(metrics: NodeMetrics): Promise<number> {
	const json = await metrics.registry.getMetricsAsJSON();
	const counter = json.find((m) => m.name === 'nodejs_eventloop_stalls_total');
	return counter?.values[0]?.value ?? 0;
}

describe('startNodeMetrics', () => {
	const started: NodeMetrics[] = [];
	const start = (...args: Parameters<typeof startNodeMetrics>) => {
		const metrics = startNodeMetrics(...args);
		started.push(metrics);
		return metrics;
	};

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		for (const metrics of started.splice(0)) metrics.stop();
		vi.useRealTimers();
	});

	it('serves process, memory and event-loop families in the Prometheus format', async () => {
		const metrics = start({ log: { warn: vi.fn() }, sampler: null });

		const text = await metrics.registry.metrics();

		expect(metrics.registry.contentType).toMatch(/^text\/plain; version=0\.0\.4/);
		for (const family of [
			'process_cpu_user_seconds_total',
			'process_resident_memory_bytes',
			'nodejs_heap_size_used_bytes',
			'nodejs_eventloop_lag_seconds',
			'nodejs_eventloop_stalls_total',
		]) {
			expect(text).toContain(`# TYPE ${family} `);
		}
	});

	it('logs one structured warning for a stall and none for ordinary windows around it', async () => {
		const warn = vi.fn();
		const sampler = scriptedSampler([
			QUIET,
			// 2.5 s gap with the loop busy for it: a real stall.
			{ delayMaxNs: 2_520 * MS, activeMs: 2_900, elapsedMs: 10_000 },
			QUIET,
			QUIET,
		]);
		const metrics = start({ log: { warn }, sampler, sampleIntervalMs: 10_000 });

		await vi.advanceTimersByTimeAsync(10_000);
		expect(warn).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(10_000);
		expect(warn).toHaveBeenCalledTimes(1);
		const [record, message] = warn.mock.calls[0]!;
		expect(message).toBe('event loop stalled for 2500 ms');
		expect(record).toMatchObject({
			event: 'runtime.event_loop.stalled',
			durationMs: 2_500,
			detail: { thresholdMs: 1_000, utilization: 0.29 },
		});
		expect(record.detail.rssMb).toEqual(expect.any(Number));
		expect(record.detail.heapUsedMb).toEqual(expect.any(Number));

		await vi.advanceTimersByTimeAsync(20_000);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(sampler.sample).toHaveBeenCalledTimes(4);
		expect(await stallCount(metrics)).toBe(1);
	});

	it('honours the configured threshold', async () => {
		const warn = vi.fn();
		const window = { delayMaxNs: 620 * MS, activeMs: 900, elapsedMs: 5_000 };
		start({
			log: { warn },
			sampler: scriptedSampler([window]),
			stallThresholdMs: 600,
			sampleIntervalMs: 5_000,
		});
		start({ log: { warn }, sampler: scriptedSampler([window]), sampleIntervalMs: 5_000 });

		await vi.advanceTimersByTimeAsync(5_000);

		// 600 ms counts against a 600 ms threshold, not against the 1 s default.
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]![0]).toMatchObject({ durationMs: 600 });
	});

	it('does not report a long gap the loop spent idle (a suspended host)', async () => {
		const warn = vi.fn();
		const metrics = start({
			log: { warn },
			sampler: scriptedSampler([{ delayMaxNs: 60_000 * MS, activeMs: 40, elapsedMs: 70_000 }]),
		});

		await vi.advanceTimersByTimeAsync(10_000);

		expect(warn).not.toHaveBeenCalled();
		expect(await stallCount(metrics)).toBe(0);
	});

	it('stop() ends sampling and releases the histogram', async () => {
		const sampler = scriptedSampler([]);
		const metrics = start({ log: { warn: vi.fn() }, sampler, sampleIntervalMs: 1_000 });

		await vi.advanceTimersByTimeAsync(1_000);
		metrics.stop();
		metrics.stop();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(sampler.sample).toHaveBeenCalledTimes(1);
		expect(sampler.stop).toHaveBeenCalledTimes(1);
		// The registry still answers during a shutdown drain.
		await expect(metrics.registry.metrics()).resolves.toContain('nodejs_eventloop_stalls_total');
	});

	it('gives every instance its own registry', async () => {
		const first = start({ log: { warn: vi.fn() }, sampler: null });
		const second = start({ log: { warn: vi.fn() }, sampler: null });

		expect(first.registry).not.toBe(second.registry);
		await expect(second.registry.metrics()).resolves.toContain('process_cpu_user_seconds_total');
	});

	it('starts and stops the real event-loop sampler', () => {
		const metrics = start({ log: { warn: vi.fn() } });

		expect(() => metrics.stop()).not.toThrow();
	});
});
