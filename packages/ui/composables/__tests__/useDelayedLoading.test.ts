/**
 * `useDelayedLoading` decides when a loader may be on screen. The two failures
 * it exists to prevent are timing failures, so every case runs on fake timers:
 *
 *  - a fast response (under `delay`) must never show the loader at all — that
 *    is the flash a warm Convex cache produced on every detail page;
 *  - a response just after `delay` must not pull the loader down one frame
 *    after it appeared — it stays up for `minVisible`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, type EffectScope } from 'vue';
import { useDelayedLoading, type DelayedLoadingOptions } from '../useDelayedLoading';

let scope: EffectScope | undefined;

function setup(initial: boolean, options?: DelayedLoadingOptions) {
	const loading = ref(initial);
	scope = effectScope();
	const visible = scope.run(() => useDelayedLoading(loading, options))!;
	return { loading, visible };
}

/** Flip the source and let the watcher run. */
async function set(source: { value: boolean }, value: boolean): Promise<void> {
	source.value = value;
	await nextTick();
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	scope?.stop();
	scope = undefined;
	vi.useRealTimers();
});

describe('useDelayedLoading', () => {
	it('never shows for a load that starts false', () => {
		const { visible } = setup(false);
		vi.advanceTimersByTime(1000);
		expect(visible.value).toBe(false);
	});

	it('waits for the delay before showing', () => {
		const { visible } = setup(true);
		expect(visible.value).toBe(false);
		vi.advanceTimersByTime(149);
		expect(visible.value).toBe(false);
		vi.advanceTimersByTime(1);
		expect(visible.value).toBe(true);
	});

	it('never shows when loading finishes inside the delay', async () => {
		const { loading, visible } = setup(true);
		vi.advanceTimersByTime(100);
		await set(loading, false);
		vi.advanceTimersByTime(1000);
		expect(visible.value).toBe(false);
	});

	it('stays up for minVisible when loading ends just after it appeared', async () => {
		const { loading, visible } = setup(true);
		vi.advanceTimersByTime(160); // shown at 150
		expect(visible.value).toBe(true);
		await set(loading, false); // 10 ms after it appeared
		expect(visible.value).toBe(true);
		vi.advanceTimersByTime(289);
		expect(visible.value).toBe(true);
		vi.advanceTimersByTime(1);
		expect(visible.value).toBe(false);
	});

	it('hides at once when it has already been up for minVisible', async () => {
		const { loading, visible } = setup(true);
		vi.advanceTimersByTime(150 + 500);
		await set(loading, false);
		expect(visible.value).toBe(false);
	});

	it('keeps the indicator up when loading resumes during the minimum window', async () => {
		const { loading, visible } = setup(true);
		vi.advanceTimersByTime(150);
		await set(loading, false);
		vi.advanceTimersByTime(100);
		await set(loading, true);
		vi.advanceTimersByTime(1000);
		expect(visible.value).toBe(true);
		await set(loading, false);
		expect(visible.value).toBe(false);
	});

	it('restarts the delay for a new load after the indicator went away', async () => {
		const { loading, visible } = setup(true);
		vi.advanceTimersByTime(50);
		await set(loading, false);
		await set(loading, true);
		vi.advanceTimersByTime(149);
		expect(visible.value).toBe(false);
		vi.advanceTimersByTime(1);
		expect(visible.value).toBe(true);
	});

	it('honours custom timings, and shows synchronously with delay 0', async () => {
		const custom = setup(true, { delay: 400, minVisible: 0 });
		vi.advanceTimersByTime(399);
		expect(custom.visible.value).toBe(false);
		vi.advanceTimersByTime(1);
		expect(custom.visible.value).toBe(true);
		await set(custom.loading, false);
		expect(custom.visible.value).toBe(false);
		scope?.stop();

		const immediate = setup(true, { delay: 0 });
		expect(immediate.visible.value).toBe(true);
	});

	it('accepts a getter as the source', async () => {
		const flag = ref(true);
		scope = effectScope();
		const visible = scope.run(() => useDelayedLoading(() => flag.value))!;
		vi.advanceTimersByTime(150);
		expect(visible.value).toBe(true);
	});

	it('clears its timers when the owning scope is disposed', () => {
		const { visible } = setup(true);
		expect(vi.getTimerCount()).toBe(1);
		scope?.stop();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(1000);
		expect(visible.value).toBe(false);
	});
});
