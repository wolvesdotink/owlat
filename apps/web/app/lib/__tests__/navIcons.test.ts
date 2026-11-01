import { describe, expect, it } from 'vitest';
import { InboxIcon, MoreVerticalIcon } from '@coolicons/vue';
import { InboxIcon as InboxFillIcon } from '@coolicons/vue/fill';
import { navIcon } from '../navIcons';
import { buildNavigationSections } from '../dashboardNavigation';
import { SETTINGS_REGISTRY } from '../settingsRegistry';
import { ADMIN_REGISTRY } from '../adminSettingsRegistry';

describe('navIcon', () => {
	it('fills the glyph of the current page and leaves the others as lines', () => {
		expect(navIcon(InboxIcon, true)).toBe(InboxFillIcon);
		expect(navIcon(InboxIcon, false)).toBe(InboxIcon);
	});

	it('keeps the line glyph for an icon it has no fill for', () => {
		expect(navIcon(MoreVerticalIcon, true)).toBe(MoreVerticalIcon);
	});

	it('has a fill for every core sidebar, preferences and admin destination', () => {
		const sections = buildNavigationSections({
			isFeatureEnabled: () => true,
			isDesktop: false,
			role: 'owner',
		});
		const icons = new Set([
			...sections.map((section) => section.icon),
			...sections.flatMap((section) => section.items.map((item) => item.icon)),
			...SETTINGS_REGISTRY.map((entry) => entry.icon),
			...ADMIN_REGISTRY.map((entry) => entry.icon),
		]);
		const unfilled = [...icons].filter((icon) => navIcon(icon, true) === icon);
		expect(unfilled.map((icon) => (icon as { displayName?: string }).displayName)).toEqual([]);
	});
});
