import { keyboardInset } from '~/utils/answerModeLayout';

/**
 * The on-screen keyboard's height over the page, in px (0 when there is none).
 *
 * Read from `window.visualViewport`, whose resize and scroll events are the
 * only signal a browser gives that a keyboard opened (see `keyboardInset` for
 * why `100dvh` alone leaves Send under it). Full-screen surfaces subtract it
 * from their height so their bottom row stays above the keyboard.
 *
 * Without a visual viewport (older browsers, unit tests) it stays 0.
 */
export function useKeyboardInset(): Readonly<Ref<number>> {
	const inset = ref(0);
	if (import.meta.server || typeof window === 'undefined' || !window.visualViewport) {
		return inset;
	}
	const viewport = window.visualViewport;
	const sync = () => {
		inset.value = keyboardInset({
			layoutHeight: window.innerHeight,
			viewportHeight: viewport.height,
			offsetTop: viewport.offsetTop,
			scale: viewport.scale,
		});
	};
	sync();
	viewport.addEventListener('resize', sync);
	viewport.addEventListener('scroll', sync);
	onScopeDispose(() => {
		viewport.removeEventListener('resize', sync);
		viewport.removeEventListener('scroll', sync);
	});
	return readonly(inset);
}
