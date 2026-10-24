import { computed, onScopeDispose, ref, type Ref } from 'vue';

/**
 * The one spelling of the reduced-motion media query in this repo, and the one
 * owner of the EFFECTIVE answer: the OS asked for less motion, OR the person
 * switched on the app's own "Reduce motion" setting. Every JavaScript caller
 * reads one of the two helpers below rather than `matchMedia` directly, so the
 * in-app switch reaches scroll behaviour and animation helpers as well as CSS.
 *
 * The app setting can only ADD reduction. With it off, the OS preference still
 * applies exactly as before; there is no "force full motion" override.
 */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** The in-app override. Module state: one per page, like the media query. */
const appReducedMotion = ref(false);
const appListeners = new Set<() => void>();

/**
 * Set the in-app "Reduce motion" override. Called by the app's preference
 * owner on load and on every change; reactive readers and the subscribers of
 * {@link onReducedMotionChange} see the new answer immediately.
 */
export function setAppReducedMotion(reduce: boolean): void {
	if (appReducedMotion.value === reduce) return;
	appReducedMotion.value = reduce;
	for (const listener of [...appListeners]) listener();
}

/** The OS half only. `false` where there is no `matchMedia`. */
function osPrefersReducedMotion(): boolean {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
	return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/**
 * Should motion be reduced right now? A one-shot read, for code that is not
 * inside a Vue component: an animation helper deciding `behavior: 'smooth'` vs
 * `'auto'` at the moment it runs has nothing to be reactive about.
 *
 * The OS half is `false` where there is no `matchMedia` (SSR, unit tests, an
 * old webview), the same default the CSS media query itself has.
 */
export function prefersReducedMotion(): boolean {
	return appReducedMotion.value || osPrefersReducedMotion();
}

/**
 * Call `listener` whenever either half of the answer may have changed (the OS
 * preference or the in-app override), for non-Vue code that caches state
 * derived from it. Returns the unsubscribe function.
 */
export function onReducedMotionChange(listener: () => void): () => void {
	appListeners.add(listener);
	let query: MediaQueryList | null = null;
	if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
		query = window.matchMedia(REDUCED_MOTION_QUERY);
		query.addEventListener('change', listener);
	}
	return () => {
		appListeners.delete(listener);
		query?.removeEventListener('change', listener);
	};
}

/**
 * Reactive effective reduced motion, for a template or a computed that has to
 * re-render when it changes.
 *
 * The listener matters more than it looks: this is a setting people turn ON
 * mid-session, usually because something on screen is making them ill, and a
 * value sampled once at mount keeps animating until the page is reloaded.
 * Disposed with the owning effect scope.
 */
export function useReducedMotion(): Readonly<Ref<boolean>> {
	const os = ref(false);
	if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
		const query = window.matchMedia(REDUCED_MOTION_QUERY);
		os.value = query.matches;
		const sync = (event: MediaQueryListEvent): void => {
			os.value = event.matches;
		};
		query.addEventListener('change', sync);
		onScopeDispose(() => query.removeEventListener('change', sync));
	}
	return computed(() => os.value || appReducedMotion.value);
}
