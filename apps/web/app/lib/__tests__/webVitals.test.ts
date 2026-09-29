import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeWebVitals, type WebVitals } from '../webVitals';

/**
 * A PerformanceObserver double: each observed type gets a feed the case pushes
 * entries into, the way the browser delivers them.
 */
class FakeObserver {
	static supportedEntryTypes = ['largest-contentful-paint', 'layout-shift', 'event'];
	static byType = new Map<string, FakeObserver>();
	queued: PerformanceEntry[] = [];
	constructor(private readonly callback: (list: { getEntries(): PerformanceEntry[] }) => void) {}
	observe(options: { type: string }) {
		FakeObserver.byType.set(options.type, this);
	}
	disconnect() {}
	takeRecords() {
		return this.queued.splice(0);
	}
	deliver(entries: Array<Record<string, unknown>>) {
		this.callback({ getEntries: () => entries as unknown as PerformanceEntry[] });
	}
}

function feed(type: string, entries: Array<Record<string, unknown>>) {
	FakeObserver.byType.get(type)?.deliver(entries);
}

function hide() {
	Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
	document.dispatchEvent(new Event('visibilitychange'));
}

describe('observeWebVitals', () => {
	let reports: WebVitals[];
	let stop: () => void;

	beforeEach(() => {
		FakeObserver.byType.clear();
		vi.stubGlobal('PerformanceObserver', FakeObserver);
		reports = [];
		stop = observeWebVitals((vitals) => reports.push(vitals));
	});

	afterEach(() => {
		stop();
		vi.unstubAllGlobals();
		Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
	});

	it('reports the last LCP candidate once, when the page is first hidden', () => {
		feed('largest-contentful-paint', [{ startTime: 420.4 }, { startTime: 812.6 }]);
		expect(reports).toEqual([]);

		hide();
		hide();
		window.dispatchEvent(new Event('pagehide'));

		expect(reports).toEqual([{ lcp_ms: 813 }]);
	});

	it('takes the largest session window of shifts without recent input as CLS', () => {
		feed('layout-shift', [
			{ startTime: 100, value: 0.05, hadRecentInput: false },
			{ startTime: 600, value: 0.05, hadRecentInput: false },
			// Right after a click: not the page's fault.
			{ startTime: 700, value: 0.5, hadRecentInput: true },
			// More than a second later: a new window, smaller than the first.
			{ startTime: 2000, value: 0.04, hadRecentInput: false },
		]);
		hide();

		expect(reports).toEqual([{ cls: 0.1 }]);
	});

	it('takes the longest interaction as INP, merging the entries of one interaction', () => {
		feed('event', [
			{ interactionId: 7, duration: 40 },
			{ interactionId: 7, duration: 96 },
			{ interactionId: 14, duration: 64 },
			// Not an interaction (no id): a hover or a scroll.
			{ interactionId: 0, duration: 500 },
		]);
		hide();

		expect(reports).toEqual([{ inp_ms: 96 }]);
	});

	it('skips one of the longest interactions per fifty, the 98th percentile', () => {
		const entries = Array.from({ length: 120 }, (_, i) => ({
			interactionId: (i + 1) * 7,
			duration: i === 0 ? 900 : i === 1 ? 700 : i === 2 ? 300 : 20,
		}));
		feed('event', entries);
		hide();

		expect(reports).toEqual([{ inp_ms: 300 }]);
	});

	it('reads entries the browser queued but had not delivered yet', () => {
		FakeObserver.byType
			.get('largest-contentful-paint')
			?.queued.push({ startTime: 1200 } as unknown as PerformanceEntry);
		hide();

		expect(reports).toEqual([{ lcp_ms: 1200 }]);
	});

	it('sends nothing when the browser measured nothing', () => {
		hide();

		expect(reports).toEqual([]);
	});
});
