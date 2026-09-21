/**
 * Route subtrees that hand their navigation over to a second column.
 *
 * Postbox brings its own folder rail, so inside it the dashboard sidebar is the
 * third navigation column on screen — 256px spent on Team Inbox, Knowledge and
 * Administration while the user triages invoices. Both sidebar widths already
 * exist and persist (`useSidebarState`); a focus area only decides which one a
 * route defaults to.
 *
 * The rule is deliberately dumb: inside a focus area the sidebar is the icon
 * rail unless the user PINNED it open there, and the pin is per-area and
 * persisted. Outside, the user's global collapse preference is untouched — so
 * pinning the sidebar open in Postbox cannot silently re-expand it everywhere
 * else, and collapsing it everywhere else cannot un-pin it here.
 *
 * Pure on purpose (see __tests__/sidebarFocusArea.test.ts): the reactive
 * wiring lives in `useSidebarState`, the mapping lives here.
 */

export type SidebarFocusArea = 'postbox';

const SIDEBAR_FOCUS_AREAS: readonly SidebarFocusArea[] = ['postbox'];

/**
 * Route prefix each focus area owns. A prefix owns its whole subtree, so a deep
 * link into a thread or the migrate wizard is as much "in Postbox" as the inbox
 * itself.
 */
const FOCUS_AREA_PREFIXES: Record<SidebarFocusArea, string> = {
	postbox: '/dashboard/postbox',
};

/** Persisted pin state, keyed by area. Absent (or non-boolean) reads as unpinned. */
export type SidebarFocusPins = Partial<Record<SidebarFocusArea, boolean>>;

const ownsPath = (prefix: string, path: string) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * The focus area a route belongs to, or `null` for ordinary dashboard routes.
 * Accepts full paths — query and hash are ignored, so `?q=` on the search page
 * does not fall out of Postbox.
 */
export function focusAreaForPath(fullPath: string): SidebarFocusArea | null {
	const path = fullPath.split(/[?#]/, 1)[0] ?? fullPath;
	for (const area of SIDEBAR_FOCUS_AREAS) {
		if (ownsPath(FOCUS_AREA_PREFIXES[area], path)) return area;
	}
	return null;
}

/** Whether the given area is pinned open. Unknown/absent entries are unpinned. */
export function isFocusAreaPinned(pins: SidebarFocusPins, area: SidebarFocusArea | null): boolean {
	if (!area) return false;
	return pins[area] === true;
}

/**
 * The collapse state the sidebar should render.
 *
 * Outside a focus area this is simply the persisted preference. Inside one the
 * pin decides, which is what makes the icon rail the default without ever
 * writing to (or reading from) the global preference.
 */
export function resolveSidebarCollapsed(
	persistedCollapsed: boolean,
	area: SidebarFocusArea | null,
	pins: SidebarFocusPins
): boolean {
	if (!area) return persistedCollapsed;
	return !isFocusAreaPinned(pins, area);
}

/** The pin map after toggling one area — used by the sidebar's collapse control. */
export function toggleFocusAreaPin(
	pins: SidebarFocusPins,
	area: SidebarFocusArea
): SidebarFocusPins {
	return { ...pins, [area]: !isFocusAreaPinned(pins, area) };
}
