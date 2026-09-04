/**
 * Reduced motion, re-exported from the UI layer so it is a Nuxt auto-import
 * here too. The implementation lives in `@owlat/ui` because `NumberTicker`
 * needs it and a layer component cannot reach into the app.
 *
 * `useReducedMotion` is the reactive one (templates, computeds); the plain
 * `prefersReducedMotion` is for the animation helpers under `lib/` that are not
 * components and have nothing to re-render.
 */
export { prefersReducedMotion, useReducedMotion } from '@owlat/ui/composables/useReducedMotion';

/**
 * Reactive `window.matchMedia`.
 *
 * The app runs with `ssr: false`, so the first value is already the real one —
 * no hydration flash. Outside a browser (unit tests) it reports `true`: a
 * viewport gate must never hide content when there is no viewport to measure.
 */
export function useMediaQuery(query: string): Ref<boolean> {
	const matches = ref(true);
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return matches;

	const mql = window.matchMedia(query);
	matches.value = mql.matches;
	const sync = (event: MediaQueryListEvent) => {
		matches.value = event.matches;
	};
	mql.addEventListener('change', sync);
	onScopeDispose(() => mql.removeEventListener('change', sync));
	return matches;
}

/**
 * Is the viewport wide enough for the email builder? The canvas plus its block
 * palette and inspector need Tailwind's `md` (768px) at minimum; below that the
 * builder routes render <EmailBuilderViewportGate> instead of a broken canvas.
 */
export function useEmailBuilderViewport(): Ref<boolean> {
	return useMediaQuery('(min-width: 768px)');
}

/**
 * Is the viewport wide enough for a multi-column data table? Below Tailwind's
 * `md` (768px) the dashboard tables render the same rows as a card list. The
 * two are alternatives, not layers: mounting both and hiding one with `md:hidden`
 * doubles the DOM and lets the copies drift apart.
 */
export function useDataTableViewport(): Ref<boolean> {
	return useMediaQuery('(min-width: 768px)');
}
