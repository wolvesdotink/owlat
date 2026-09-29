import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';

import { useNow } from '../useNow';

/**
 * The reactive clock every countdown and "2h ago" label reads. What matters:
 * it moves on its interval, it can hand out a Date, and disposing the scope
 * that created it stops the interval, whether that scope is a component or a
 * composable.
 */
describe('useNow', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-10T09:00:00Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('refreshes epoch ms on every interval', () => {
		const scope = effectScope();
		const now = scope.run(() => useNow({ intervalMs: 250 }))!;
		const start = Date.now();
		expect(now.value).toBe(start);

		vi.advanceTimersByTime(249);
		expect(now.value).toBe(start);
		vi.advanceTimersByTime(1);
		expect(now.value).toBe(start + 250);
		vi.advanceTimersByTime(750);
		expect(now.value).toBe(start + 1000);
		scope.stop();
	});

	it("hands out a Date with as: 'date'", () => {
		const scope = effectScope();
		const now = scope.run(() => useNow({ intervalMs: 60_000, as: 'date' }))!;
		expect(now.value).toBeInstanceOf(Date);
		expect(now.value.toISOString()).toBe('2026-03-10T09:00:00.000Z');

		vi.advanceTimersByTime(60_000);
		expect(now.value.toISOString()).toBe('2026-03-10T09:01:00.000Z');
		scope.stop();
	});

	it('stops ticking once its scope is disposed', () => {
		const scope = effectScope();
		const now = scope.run(() => useNow({ intervalMs: 1000 }))!;
		vi.advanceTimersByTime(1000);
		const last = now.value;

		scope.stop();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(5000);
		expect(now.value).toBe(last);
	});

	it('starts no interval outside an effect scope, so nothing can leak', () => {
		const now = useNow({ intervalMs: 1000 });
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(5000);
		expect(now.value).toBe(new Date('2026-03-10T09:00:00Z').getTime());
	});

	it('gives each caller its own interval', () => {
		const first = effectScope();
		const second = effectScope();
		first.run(() => useNow({ intervalMs: 250 }));
		const kept = second.run(() => useNow({ intervalMs: 250 }))!;
		expect(vi.getTimerCount()).toBe(2);

		first.stop();
		vi.advanceTimersByTime(250);
		expect(kept.value).toBe(Date.now());
		second.stop();
		expect(vi.getTimerCount()).toBe(0);
	});
});
