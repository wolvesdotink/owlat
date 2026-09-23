/**
 * What the phone tab bar's "More" lists: every top-level destination the tab
 * bar does not already hold (#778).
 *
 * "More" used to open the whole navigation drawer, the same one the header's
 * menu button opens, so the phone offered two routes to one long list and
 * repeated Today, the Answer queue and the inboxes the bar sits right under.
 * This picks one entry per navigation section instead, from the same gated
 * sections the sidebar renders, so a destination the viewer cannot reach never
 * shows up here either.
 *
 * Pure (no Vue, no Nuxt): the tab bar feeds it the resolved sections and the
 * hrefs of its own slots.
 */
import type { NavigationSection } from './dashboardNavigation';

export interface MoreDestination {
	/** The section key, stable for `v-for`. */
	key: string;
	/** i18n key (a plugin's own label passes through `t()` unchanged). */
	name: string;
	href: string;
	icon: string;
}

/** Tab hrefs that already stand for the mailbox as a whole. */
const MAILBOX_TAB_HREFS = new Set(['/dashboard/inboxes', '/dashboard/postbox']);

export function mobileMoreDestinations(
	sections: readonly NavigationSection[],
	tabHrefs: readonly string[]
): MoreDestination[] {
	const covered = new Set(tabHrefs);
	const hasMailboxTab = tabHrefs.some((href) => MAILBOX_TAB_HREFS.has(href));
	const out: MoreDestination[] = [];
	for (const section of sections) {
		// The Inbox tab is the mailbox; its folders are inside it, not here.
		if (section.key === 'postbox' && hasMailboxTab) continue;
		const href = section.href ?? section.items[0]?.href;
		if (!href || covered.has(href)) continue;
		covered.add(href);
		out.push({ key: section.key, name: section.name, href, icon: section.icon });
	}
	return out;
}
