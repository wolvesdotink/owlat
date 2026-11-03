import { describe, expect, it } from 'vitest';
import { InboxIcon, MoreVerticalIcon } from '@coolicons/vue';
import { InboxIcon as InboxFillIcon } from '@coolicons/vue/fill';
import { loadNavIconFills, navIcon } from '../navIcons';
import { buildNavigationSections } from '../dashboardNavigation';

describe('navIcon', () => {
	it('shows the line glyph until the fills arrive, then fills the current page only', async () => {
		// First in the file: the fills load on demand and stay loaded.
		expect(navIcon(InboxIcon, true)).toBe(InboxIcon);
		await loadNavIconFills();
		expect(navIcon(InboxIcon, true)).toBe(InboxFillIcon);
		expect(navIcon(InboxIcon, false)).toBe(InboxIcon);
	});

	it('keeps the line glyph for an icon it has no fill for', () => {
		expect(navIcon(MoreVerticalIcon, true)).toBe(MoreVerticalIcon);
	});

	it('has a fill for every core sidebar destination', () => {
		const sections = buildNavigationSections({
			isFeatureEnabled: () => true,
			isDesktop: false,
			role: 'owner',
		});
		// What the sidebar renders (layouts/dashboard.vue): Administration and My
		// settings have their own navigation, and a section with an `href` is one
		// flat link whose items only feed the palette.
		const shown = sections.filter(
			(section) => section.key !== 'administration' && section.key !== 'preferences'
		);
		const icons = new Set([
			...shown.map((section) => section.icon),
			...shown.flatMap((section) => (section.href ? [] : section.items.map((item) => item.icon))),
		]);
		const unfilled = [...icons].filter((icon) => navIcon(icon, true) === icon);
		expect(unfilled.map((icon) => (icon as { displayName?: string }).displayName)).toEqual([]);
	});
});
