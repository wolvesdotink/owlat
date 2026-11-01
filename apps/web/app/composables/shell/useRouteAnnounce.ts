import { announcedPageLabel, shouldMoveFocusToMain } from '~/utils/liveAnnounce';

// ── Route changes, said out loud ──────────────────────────────────────────
// A client-side navigation is INVISIBLE to assistive technology. The browser
// announces a real page load; a router that swaps the DOM under <main> announces
// nothing, and keyboard focus is left standing on the rail link that was just
// activated — several dozen tab stops away from the page it loaded. Two lines
// of repair, both standard: say the new page's name into the app's live region,
// and move focus into <main> (whose `tabindex="-1"` has been sitting below,
// unfocused by anything, since it was added for the skip link).
//
// `route.path`, not `fullPath`: a query change is a filter or a sort, not a new
// page, and re-announcing the same page name on every keystroke of a search box
// is worse than saying nothing.
export function useRouteAnnounce(): void {
	const { t } = useI18n();
	const route = useRoute();
	const { announce } = useAnnounce();
	const { breadcrumbs } = useBreadcrumbs();

	watch(
		() => route.path,
		async () => {
			// The new page has to be rendered before its trail is right and before
			// asking where focus ended up.
			await nextTick();
			const label = announcedPageLabel(breadcrumbs.value);
			// Trail labels are message keys from the route registries and plain text
			// when a page supplied one dynamically; `t` passes the latter through.
			if (label) announce(t('shell.dashboard.navigatedTo', { page: t(label) }));
			if (shouldMoveFocusToMain(document.activeElement)) {
				// `preventScroll`: the router has already restored the scroll position,
				// and focusing a full-height <main> would undo it.
				document.getElementById('main-content')?.focus({ preventScroll: true });
			}
		}
	);
}
