import type { MaybeRefOrGetter } from 'vue';
import { FAVICON_HEAD_KEY, UNREAD_FAVICON_HREF, badgedTitle } from '~/lib/tabBadge';

/**
 * Paint an unread count onto the browser tab: a `(N)` prefix on the page's
 * own title and a dotted favicon, both from the same number.
 *
 * Everything goes through one reactive head entry owned by the caller's
 * component, so the head manager does the bookkeeping: at zero the entry is
 * empty and the page title and plain favicon show through, and when the owner
 * unmounts (leaving the dashboard, signing out) the entry is disposed and both
 * are restored. Pages keep setting their titles as before; the prefix is a
 * title template, so it follows route and locale changes without anyone
 * re-applying it and can never stack twice.
 *
 * `null` means "not known yet" and paints nothing.
 */
export function useTabBadge(count: MaybeRefOrGetter<number | null>): void {
	const shown = computed(() => Math.max(0, toValue(count) ?? 0));
	useHead(() => {
		const n = shown.value;
		if (n === 0) return {};
		return {
			titleTemplate: (title?: string | null) => badgedTitle(title, n),
			link: [
				{
					key: FAVICON_HEAD_KEY,
					rel: 'icon',
					type: 'image/svg+xml',
					href: UNREAD_FAVICON_HREF,
				},
			],
		};
	});
}
