import type { Ref } from 'vue';
import { distinctAnnouncement } from '~/utils/liveAnnounce';

/** How urgently the message interrupts. Mirrors `aria-live`. */
export type Politeness = 'polite' | 'assertive';

/**
 * ONE live region for the whole app, so module scope rather than per-caller
 * state. Two of them (polite and assertive) because the two politenesses are
 * separate regions in the DOM: writing an urgent message into the polite region
 * does not make it urgent, and swapping a region's `aria-live` value at runtime
 * is not reliably picked up by assistive technology.
 *
 * `<AppLiveRegion>` renders these; nothing else should read them.
 */
const politeMessage = ref('');
const assertiveMessage = ref('');

/**
 * Say something to a screen reader without showing it to anyone else.
 *
 * The gap this closes is the whole class of state changes this app makes
 * SILENTLY: a save that only repaints a button, a filter that swaps the rows
 * under a heading, a route change in a single-page app (where nothing in the
 * browser announces the new page at all). A sighted user sees each of those;
 * a screen-reader user is told nothing.
 *
 * Callers pass finished, translated copy. This composable is deliberately
 * `t`-free: it is called from places that already have the right `t` in scope
 * (and from `useBackendOperation`, which owns its own copy), and a composable
 * that resolved keys itself would have to guess at parameters.
 *
 * `useBackendOperation` already announces every mutation it runs, so most
 * callers get this for free and only reach for `announce` directly for the
 * state changes no backend write is behind — filters, view switches, an
 * expand/collapse whose result is off screen.
 */
export function useAnnounce(): {
	announce: (message: string, politeness?: Politeness) => void;
	clear: () => void;
	politeMessage: Readonly<Ref<string>>;
	assertiveMessage: Readonly<Ref<string>>;
} {
	function announce(message: string, politeness: Politeness = 'polite'): void {
		const target = politeness === 'assertive' ? assertiveMessage : politeMessage;
		target.value = distinctAnnouncement(target.value, message);
	}

	/** Empty both regions — for a surface that is tearing down mid-announcement. */
	function clear(): void {
		politeMessage.value = '';
		assertiveMessage.value = '';
	}

	return {
		announce,
		clear,
		politeMessage: readonly(politeMessage),
		assertiveMessage: readonly(assertiveMessage),
	};
}
