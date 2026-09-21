import { onScopeDispose, ref, type Ref } from 'vue';

/**
 * The one spelling of the reduced-motion media query in this repo.
 *
 * It was spelled out by hand in four places — a desktop workspace crossfade, two
 * Postbox scroll-into-view calls and the number ticker — each with its own
 * guard for "is there a `window`", its own listener wiring (three of the four
 * had none, so a preference changed mid-session was ignored until reload) and
 * its own answer for what to do when the API is missing.
 */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Has the viewer asked their OS to reduce motion? A one-shot read, for code
 * that is not inside a Vue component: an animation helper deciding
 * `behavior: 'smooth'` vs `'auto'` at the moment it runs has nothing to be
 * reactive about.
 *
 * `false` where there is no `matchMedia` (SSR, unit tests, an old webview) —
 * the same default the CSS media query itself has, so behaviour off the browser
 * matches behaviour in a browser with no preference set.
 */
export function prefersReducedMotion(): boolean {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
	return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/**
 * Reactive `prefers-reduced-motion`, for a template or a computed that has to
 * re-render when the preference changes.
 *
 * The listener matters more than it looks: this is a setting people turn ON
 * mid-session, usually because something on screen is making them ill, and a
 * value sampled once at mount keeps animating until the page is reloaded.
 * Disposed with the owning effect scope.
 */
export function useReducedMotion(): Ref<boolean> {
	const reduced = ref(false);
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return reduced;

	const query = window.matchMedia(REDUCED_MOTION_QUERY);
	reduced.value = query.matches;
	const sync = (event: MediaQueryListEvent): void => {
		reduced.value = event.matches;
	};
	query.addEventListener('change', sync);
	onScopeDispose(() => query.removeEventListener('change', sync));
	return reduced;
}
