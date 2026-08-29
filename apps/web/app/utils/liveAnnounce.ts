/**
 * Pure helpers behind the app's single live region (`useAnnounce`).
 *
 * The logic lives here rather than in the composable because both rules below
 * are the kind that are wrong in a way no screenshot shows: they are about what
 * a screen reader SAYS, and the only way to keep them honest is a unit test.
 */

/**
 * Appended to force a re-announcement. A no-break space is invisible, does not
 * collapse the way a plain space does, and is not spoken.
 */
export const RE_ANNOUNCE_MARK = '\u00A0';

/**
 * Squash the whitespace a template's indentation leaves behind. A live region
 * is read verbatim, so `"Saved\n\t\t\tContacts"` is announced with the pause
 * the newline implies.
 */
export function normalizeAnnouncement(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/**
 * The text to write into the region so `next` is actually spoken, given what
 * the region already holds.
 *
 * Assistive technology announces a live region when its content CHANGES, so
 * writing the same string twice is silent the second time — which is exactly
 * the case that matters: saving the same form twice, deleting two rows in a
 * row, hitting the same error again. Re-saying an identical message appends an
 * invisible mark so the DOM text differs; the next identical one drops it
 * again, so the pair alternates forever without the string growing.
 *
 * Empty (or whitespace-only) input returns `''`, which clears the region
 * rather than announcing a blank.
 */
export function distinctAnnouncement(previous: string, next: string): string {
	const normalized = normalizeAnnouncement(next);
	if (normalized.length === 0) return '';
	if (previous !== normalized) return normalized;
	return `${normalized}${RE_ANNOUNCE_MARK}`;
}

/** A breadcrumb trail, as `useBreadcrumbs` hands it over. */
export interface AnnouncedCrumb {
	label: string;
}

/**
 * The label to announce (and to treat as the page's name) after a route change:
 * the last crumb in the trail, which is the page itself.
 *
 * Returns `null` for an empty trail rather than inventing a name — the caller
 * then announces nothing, which is better than announcing "Dashboard" on a page
 * that is not the dashboard. Labels are message KEYS where they come from the
 * route registries and plain text where a page supplied them dynamically (a
 * contact name, a campaign title); resolving that is the caller's job, because
 * only it has `t`.
 */
export function announcedPageLabel(crumbs: readonly AnnouncedCrumb[]): string | null {
	const last = crumbs.at(-1);
	if (!last) return null;
	const label = last.label.trim();
	return label.length > 0 ? label : null;
}

/**
 * After a client-side navigation, should focus be moved into `<main>`?
 *
 * Always moving it is the usual advice and it is wrong here: this app has
 * surfaces where navigating IS the interaction — walking the Postbox thread
 * list with the arrow keys changes the route on every row — and yanking focus
 * to `<main>` on each step would make the list unusable with a keyboard.
 *
 * So the question is where focus is standing once the new page has rendered:
 *
 *  - nowhere (`null`, or on `<body>`, which is where the browser dumps it when
 *    the element that had it was unmounted): focus was LOST, and the next Tab
 *    would restart from the top of the document. Move it.
 *  - inside the app chrome — a rail link, the header, a landmark navigation:
 *    the person activated a destination and is now standing on the control they
 *    left, not on what it loaded. Move it.
 *  - anywhere else that survived the navigation, `<main>` included: whatever
 *    holds focus is still there and still meaningful. Leave it alone.
 */
export function shouldMoveFocusToMain(active: Element | null): boolean {
	if (active === null || active.tagName === 'BODY') return true;
	if (active.closest('#main-content') !== null) return false;
	return active.closest('nav, header, [role="navigation"], [role="banner"]') !== null;
}
