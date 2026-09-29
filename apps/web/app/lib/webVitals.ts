/**
 * LCP, INP and CLS from the browser's own PerformanceObserver entries.
 *
 * A small reading of the Core Web Vitals definitions instead of the
 * `web-vitals` package, so nothing new lands in the entry chunk:
 *
 * - LCP: the start time of the last `largest-contentful-paint` entry. The
 *   browser stops emitting them after the first input, so the last one is final.
 * - CLS: the largest session window of `layout-shift` values that had no recent
 *   input (shifts less than 1 s apart, window at most 5 s long).
 * - INP: the longest interaction, or with 50+ interactions the 98th percentile
 *   (skip one of the longest per 50). Only the ten longest are kept, which is
 *   enough for 500 interactions and keeps a mail client left open all day flat.
 *
 * The values are reported once per page load, on the first time the page is
 * hidden (tab switch, window close, app quit). Browsers without an entry type
 * simply leave that metric out.
 */

export type WebVitals = { lcp_ms?: number; inp_ms?: number; cls?: number };

type LayoutShiftEntry = PerformanceEntry & { value: number; hadRecentInput: boolean };
type EventTimingEntry = PerformanceEntry & { interactionId?: number };

const KEPT_INTERACTIONS = 10;

export function observeWebVitals(report: (vitals: WebVitals) => void): () => void {
	if (typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') {
		return () => {};
	}
	const supported = PerformanceObserver.supportedEntryTypes ?? [];
	const observers: Array<[PerformanceObserver, (entries: PerformanceEntry[]) => void]> = [];

	function observe(
		type: string,
		onEntries: (entries: PerformanceEntry[]) => void,
		extra: Record<string, unknown> = {}
	) {
		if (!supported.includes(type)) return;
		try {
			const observer = new PerformanceObserver((list) => onEntries(list.getEntries()));
			observer.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
			observers.push([observer, onEntries]);
		} catch {
			// An engine that lists the type but rejects the options: skip the metric.
		}
	}

	let lcp: number | undefined;
	observe('largest-contentful-paint', (entries) => {
		const last = entries.at(-1);
		if (last) lcp = last.startTime;
	});

	let cls: number | undefined;
	let windowValue = 0;
	let windowStart = 0;
	let lastShift = 0;
	observe('layout-shift', (entries) => {
		for (const entry of entries as LayoutShiftEntry[]) {
			if (entry.hadRecentInput) continue;
			const at = entry.startTime;
			if (windowValue > 0 && at - lastShift < 1000 && at - windowStart < 5000) {
				windowValue += entry.value;
			} else {
				windowValue = entry.value;
				windowStart = at;
			}
			lastShift = at;
			cls = Math.max(cls ?? 0, windowValue);
		}
	});

	// interactionId -> longest duration among the entries of that interaction.
	const longest = new Map<number, number>();
	let interactions = 0;
	let lastInteractionId = 0;
	observe(
		'event',
		(entries) => {
			for (const entry of entries as EventTimingEntry[]) {
				const id = entry.interactionId;
				if (!id) continue;
				// Ids only grow, so a larger one is a new interaction.
				if (id > lastInteractionId) {
					interactions += 1;
					lastInteractionId = id;
				}
				longest.set(id, Math.max(longest.get(id) ?? 0, entry.duration));
				if (longest.size > KEPT_INTERACTIONS) {
					let shortestId = id;
					for (const [key, duration] of longest) {
						if (duration < (longest.get(shortestId) ?? Infinity)) shortestId = key;
					}
					longest.delete(shortestId);
				}
			}
		},
		// 16 ms is the lowest threshold the spec allows; the default 104 ms would
		// hide every interaction a user could still feel.
		{ durationThreshold: 16 }
	);

	function inp(): number | undefined {
		if (longest.size === 0) return undefined;
		const durations = [...longest.values()].sort((a, b) => b - a);
		return durations[Math.min(durations.length - 1, Math.floor(interactions / 50))];
	}

	let done = false;
	function stop() {
		done = true;
		for (const [observer] of observers) observer.disconnect();
		document.removeEventListener('visibilitychange', onVisibility);
		window.removeEventListener('pagehide', flush);
	}

	function flush() {
		if (done) return;
		// Read what the browser has queued but not delivered yet.
		for (const [observer, onEntries] of observers) onEntries(observer.takeRecords());
		const vitals: WebVitals = {};
		if (lcp !== undefined) vitals.lcp_ms = Math.round(lcp);
		const worst = inp();
		if (worst !== undefined) vitals.inp_ms = Math.round(worst);
		if (cls !== undefined) vitals.cls = Math.round(cls * 10000) / 10000;
		stop();
		if (Object.keys(vitals).length > 0) report(vitals);
	}

	function onVisibility() {
		if (document.visibilityState === 'hidden') flush();
	}

	document.addEventListener('visibilitychange', onVisibility);
	window.addEventListener('pagehide', flush);
	return stop;
}
