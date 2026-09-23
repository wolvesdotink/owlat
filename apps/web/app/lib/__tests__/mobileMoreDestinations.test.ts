import { describe, it, expect } from 'vitest';
import { buildNavigationSections } from '../dashboardNavigation';
import { mobileMoreDestinations } from '../mobileMoreDestinations';
import type { OrganizationRole } from '~/composables/useOrganization';

const TABS = ['/dashboard', '/dashboard/answer', '/dashboard/inboxes'];

function sectionsFor(role: OrganizationRole, flags: 'all' | string[] = 'all') {
	return buildNavigationSections({
		isFeatureEnabled: (flag) => flags === 'all' || flags.includes(flag),
		isDesktop: false,
		role,
	});
}

describe('mobileMoreDestinations (#778)', () => {
	it('lists what the tab bar does not hold, one entry per section', () => {
		const more = mobileMoreDestinations(sectionsFor('owner'), TABS);
		const hrefs = more.map((d) => d.href);
		expect(hrefs).toContain('/dashboard/inbox');
		expect(hrefs).toContain('/dashboard/chat');
		expect(hrefs).toContain('/dashboard/marketing');
		expect(hrefs).toContain('/dashboard/preferences');
		expect(new Set(hrefs).size).toBe(hrefs.length);
	});

	it('never repeats a tab, and leaves the mailbox to the Inbox tab', () => {
		const hrefs = mobileMoreDestinations(sectionsFor('owner'), TABS).map((d) => d.href);
		for (const tab of TABS) expect(hrefs).not.toContain(tab);
		expect(hrefs.some((href) => href.startsWith('/dashboard/postbox'))).toBe(false);
	});

	it('shows a member only what a member can reach', () => {
		const hrefs = mobileMoreDestinations(sectionsFor('editor'), TABS).map((d) => d.href);
		expect(hrefs).not.toContain('/dashboard/admin');
		expect(hrefs).not.toContain('/dashboard/chat');
		expect(hrefs).toContain('/dashboard/preferences');
	});

	it('drops the team inbox when it is the Inbox tab', () => {
		const hrefs = mobileMoreDestinations(sectionsFor('owner', ['inbox']), [
			'/dashboard',
			'/dashboard/answer',
			'/dashboard/inbox',
		]).map((d) => d.href);
		expect(hrefs).not.toContain('/dashboard/inbox');
	});

	it('keeps the mailbox in the list when there is no Inbox tab for it', () => {
		const hrefs = mobileMoreDestinations(sectionsFor('owner'), ['/dashboard']).map((d) => d.href);
		expect(hrefs).toContain('/dashboard/postbox');
	});
});
