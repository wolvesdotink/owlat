/**
 * Pure rules for the browser tab's unread badge: the `(N)` title prefix and
 * the dotted favicon. Vue-free so the formatting is testable on its own;
 * `useTabBadge` applies them through the head manager.
 */

/**
 * Head `key` of the app's `rel="icon"` link. `nuxt.config.ts` declares the
 * plain favicon under this key and `useTabBadge` pushes the dotted one under
 * the same key, so the head manager swaps one for the other instead of
 * stacking a second icon link (browsers disagree on which of two they show).
 */
export const FAVICON_HEAD_KEY = 'favicon';

/** The Owlat favicon with an unread dot cut into its top-right corner. */
export const UNREAD_FAVICON_HREF = '/favicon-unread.svg';

/** Shown when the current page has not set a title of its own. */
const FALLBACK_TITLE = 'Owlat';

/**
 * The tab title with the unread count in front: `(3) Mail — Owlat`. The page
 * keeps owning its title (localized, brand suffix included); this only
 * prefixes it, so a route or locale change re-renders under the same count.
 * A count of zero or less leaves the title untouched.
 */
export function badgedTitle(title: string | null | undefined, count: number): string {
	const base = title && title.trim() !== '' ? title : FALLBACK_TITLE;
	return count > 0 ? `(${Math.floor(count)}) ${base}` : base;
}
