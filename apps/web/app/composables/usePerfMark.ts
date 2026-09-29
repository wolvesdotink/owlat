import { isFirstView, reportPerf } from '~/lib/perfTelemetry';

/**
 * Custom timings on the browser's User Timing API.
 *
 * `mark(name)` sets a start point; `measure(metric, startMark)` ends the span,
 * records it as a `performance.measure` (so it shows in the DevTools timeline
 * too) and reports it as `metric` with `duration_ms`. Without a start mark the
 * span starts at navigation start. Reporting goes through `lib/perfTelemetry`,
 * which sends nothing unless PostHog is configured and `analytics.posthog` is on.
 */
const reportedBoot = new Set<string>();

function measureSpan(metric: string, startMark?: string): number | null {
	if (typeof performance === 'undefined') return null;
	try {
		const entry = performance.measure(metric, startMark ? { start: startMark } : { start: 0 });
		if (entry) return entry.duration;
	} catch {
		// No such start mark (it was never set, or already consumed).
		return null;
	}
	// Engines whose measure() returns nothing: read the span by hand.
	const start = startMark ? performance.getEntriesByName(startMark, 'mark').at(-1)?.startTime : 0;
	return start === undefined ? null : performance.now() - start;
}

export function usePerfMark() {
	function mark(name: string): void {
		if (typeof performance === 'undefined') return;
		performance.mark(name);
	}

	function measure(metric: string, startMark?: string): number | null {
		const duration = measureSpan(metric, startMark);
		if (startMark && typeof performance !== 'undefined') performance.clearMarks(startMark);
		if (duration !== null) reportPerf(metric, { duration_ms: Math.round(duration) });
		return duration;
	}

	/**
	 * Navigation start to now, reported once per page load and only while the
	 * app still shows the route it booted into (see `isFirstView`).
	 */
	function measureBoot(metric: string): void {
		if (reportedBoot.has(metric) || !isFirstView()) return;
		reportedBoot.add(metric);
		measure(metric);
	}

	return { mark, measure, measureBoot };
}
