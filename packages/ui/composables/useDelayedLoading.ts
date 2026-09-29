import {
	onScopeDispose,
	readonly,
	ref,
	toValue,
	watch,
	type MaybeRefOrGetter,
	type Ref,
} from 'vue';

export interface DelayedLoadingOptions {
	/**
	 * How long `isLoading` has to stay true before the indicator appears, in ms.
	 * A response that lands inside this window never shows a loader at all.
	 */
	delay?: number;
	/**
	 * Once shown, the indicator stays up at least this long, in ms, so a
	 * response that lands just after `delay` does not flash it for one frame.
	 */
	minVisible?: number;
}

/** Below ~150 ms a wait reads as instant; a loader there is only a flicker. */
export const DEFAULT_LOADING_DELAY_MS = 150;
/** Long enough to register as a deliberate state rather than a glitch. */
export const DEFAULT_LOADING_MIN_VISIBLE_MS = 300;

/**
 * Should a loading indicator be on screen right now?
 *
 * A raw `isLoading` flag flips true for every subscription, including the many
 * that a warm cache or a fast backend answer in a few dozen milliseconds, so a
 * spinner or skeleton bound straight to it flashes on and off. This debounces
 * it in both directions:
 *
 *  - it turns true only after `isLoading` has been true for `delay` ms;
 *  - once true, it stays true for at least `minVisible` ms, even if loading
 *    finished sooner, and then follows `isLoading` back to false.
 *
 * A loading flag that is false from the start never shows anything. A flag
 * that drops and comes back while the indicator is up keeps it up without
 * restarting the delay. With `delay: 0` the indicator is shown synchronously.
 *
 * Callers still decide what to render while loading but not yet showing the
 * indicator (usually nothing, or the stale content). Timers are cleared with
 * the owning effect scope.
 */
export function useDelayedLoading(
	isLoading: MaybeRefOrGetter<boolean>,
	options: DelayedLoadingOptions = {}
): Readonly<Ref<boolean>> {
	const delay = Math.max(0, options.delay ?? DEFAULT_LOADING_DELAY_MS);
	const minVisible = Math.max(0, options.minVisible ?? DEFAULT_LOADING_MIN_VISIBLE_MS);

	const visible = ref(false);
	let shownAt = 0;
	let showTimer: ReturnType<typeof setTimeout> | undefined;
	let hideTimer: ReturnType<typeof setTimeout> | undefined;

	function clearShowTimer(): void {
		if (showTimer === undefined) return;
		clearTimeout(showTimer);
		showTimer = undefined;
	}

	function clearHideTimer(): void {
		if (hideTimer === undefined) return;
		clearTimeout(hideTimer);
		hideTimer = undefined;
	}

	function show(): void {
		showTimer = undefined;
		shownAt = Date.now();
		visible.value = true;
	}

	function hide(): void {
		hideTimer = undefined;
		visible.value = false;
	}

	watch(
		() => toValue(isLoading),
		(loading) => {
			if (loading) {
				// Back to loading while the indicator is still up: keep it.
				clearHideTimer();
				if (visible.value || showTimer !== undefined) return;
				if (delay === 0) show();
				else showTimer = setTimeout(show, delay);
				return;
			}

			// Finished before the delay ran out: the indicator never appears.
			clearShowTimer();
			if (!visible.value || hideTimer !== undefined) return;
			const remaining = minVisible - (Date.now() - shownAt);
			if (remaining <= 0) hide();
			else hideTimer = setTimeout(hide, remaining);
		},
		{ immediate: true }
	);

	onScopeDispose(() => {
		clearShowTimer();
		clearHideTimer();
	});

	return readonly(visible);
}
