/**
 * Page identity and page transitions for the Postbox.
 *
 * The folder list and the open message are one page
 * (`pages/dashboard/postbox/[folder]/[[messageId]].vue`). Nuxt keys a page by
 * its interpolated path by default, so every open, j/k, back and folder switch
 * would unmount the rail, the list and the reader and mount them again. A
 * constant key keeps that page mounted: the folder and the message are state
 * the layout already reacts to, not reasons to rebuild it.
 *
 * Moving between two Postbox pages (the folder view, search, contacts, a
 * label, ...) swaps instantly. The app-wide out-in fade stays for moves into
 * and out of the Postbox, which are moves between top-level sections.
 */
import type { RouteLocationNormalized } from 'vue-router';

/** The folder page's key. Ignores both the folder and the message id. */
export const POSTBOX_PAGE_KEY = 'postbox';

const POSTBOX_PATH_RE = /^\/dashboard\/postbox(?:\/|$)/;

export function isPostboxPath(path: string): boolean {
	return POSTBOX_PATH_RE.test(path);
}

/**
 * The swap used inside the Postbox. It keeps a transition wrapper rather than
 * turning transitions off (`false`): with `false` Nuxt renders the page without
 * a `<Transition>`, and the next move out of the Postbox would mount a fresh
 * one, which neither fades the old page out nor the new one in. With
 * `css: false` and no JS hooks, the out-in leave completes at once.
 */
export const POSTBOX_INSTANT_PAGE_TRANSITION = Object.freeze({
	name: 'page',
	mode: 'out-in',
	css: false,
} as const);

/**
 * Inline route middleware for every Postbox page: a move whose both ends are
 * in the Postbox gets the instant swap. `to.meta` is a fresh object per
 * resolved location, so the override never leaks into a later navigation.
 */
export function postboxPageTransition(
	to: Pick<RouteLocationNormalized, 'path' | 'meta'>,
	from: Pick<RouteLocationNormalized, 'path'>
): void {
	if (isPostboxPath(to.path) && isPostboxPath(from.path)) {
		to.meta.pageTransition = { ...POSTBOX_INSTANT_PAGE_TRANSITION };
	}
}
