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
