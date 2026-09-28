/**
 * A reactive clock: a readonly ref holding the current time, refreshed every
 * `intervalMs`.
 *
 * Use it for anything that has to move while the page sits still: an undo
 * countdown (250 ms), relative "2h ago" timestamps, a local-midnight rollover
 * (60 s). The interval is stopped with `onScopeDispose`, so the clock works the
 * same in a component and inside a composable, and the caller has nothing to
 * clean up.
 *
 * The interval only runs in the browser and only inside an active effect
 * scope. Anywhere else the ref keeps the time it was created with, rather than
 * starting an interval nothing would ever stop.
 *
 * Each caller gets its own interval. Sharing one per period would leave callers
 * reading a value up to one period old when they mount, and the call sites are
 * few.
 */
import { computed, getCurrentScope, onScopeDispose, readonly, shallowRef, type Ref } from 'vue';

interface UseNowOptions {
	/** How often the value refreshes, in milliseconds. */
	intervalMs: number;
	/** `'ms'` (default) for epoch milliseconds, `'date'` for a `Date`. */
	as?: 'ms' | 'date';
}

export function useNow(options: { intervalMs: number; as?: 'ms' }): Readonly<Ref<number>>;
export function useNow(options: { intervalMs: number; as: 'date' }): Readonly<Ref<Date>>;
export function useNow({
	intervalMs,
	as = 'ms',
}: UseNowOptions): Readonly<Ref<number>> | Readonly<Ref<Date>> {
	const now = shallowRef(Date.now());
	if (typeof window !== 'undefined' && getCurrentScope()) {
		const timer = setInterval(() => {
			now.value = Date.now();
		}, intervalMs);
		onScopeDispose(() => clearInterval(timer));
	}
	return as === 'date' ? computed(() => new Date(now.value)) : readonly(now);
}
