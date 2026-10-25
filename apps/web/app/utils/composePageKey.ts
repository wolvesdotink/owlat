/**
 * The compose page's instance key: one per compose request (`?c=`), so a new
 * open remounts the editor while the page's own URL rewrite, which keeps `c`,
 * does not.
 *
 * A leaf with no imports on purpose: `definePageMeta` is hoisted out of
 * `pages/dashboard/compose.vue` into the generated route table, which is part of
 * the boot bundle, so whatever module this lives in loads on every page.
 */
export function composePageKey(rawRequestKey: unknown): string {
	const value = Array.isArray(rawRequestKey) ? rawRequestKey[0] : rawRequestKey;
	return `compose:${typeof value === 'string' ? value : ''}`;
}
