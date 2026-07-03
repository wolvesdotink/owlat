// @vitest-environment happy-dom
/**
 * PostboxFolderList in both rail states:
 *   - expanded renders labelled rows with an inline unread count
 *   - collapsed renders an icon-only strip (no label text) with the unread
 *     count as a corner badge and a tooltip/aria-label carrying the name, and
 *   - flipping `collapsed` back re-expands to the labelled rows.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import PostboxFolderList from '../PostboxFolderList.vue';

const iconStub = { props: ['name'], template: '<span class="icon" :data-name="name" />' };
const nuxtLinkStub = {
	props: ['to', 'title', 'ariaLabel'],
	template: '<a :href="to" :title="title" :aria-label="ariaLabel"><slot /></a>',
};

const folders = [
	{ _id: 'f1', name: 'Inbox', role: 'inbox', unseenCount: 4, totalCount: 10 },
	{ _id: 'f2', name: 'Sent', role: 'sent', unseenCount: 0, totalCount: 3 },
];

function mountList(collapsed: boolean) {
	return mount(PostboxFolderList, {
		props: { folders, unreadCounts: { inbox: 4 }, activeFolder: 'inbox', collapsed },
		global: { components: { Icon: iconStub, NuxtLink: nuxtLinkStub } },
	});
}

describe('PostboxFolderList', () => {
	it('renders labelled rows with an inline unread count when expanded', () => {
		const w = mountList(false);
		expect(w.text()).toContain('inbox');
		expect(w.text()).toContain('sent');
		// unread count present
		expect(w.text()).toContain('4');
	});

	it('renders an icon-only strip with badges + tooltips when collapsed', () => {
		const w = mountList(true);
		// Icons for every folder still render.
		expect(w.findAll('.icon')).toHaveLength(2);
		// No label text in the strip.
		expect(w.text().toLowerCase()).not.toContain('inbox');
		expect(w.text().toLowerCase()).not.toContain('sent');
		// The name lives on the link tooltip/aria-label for hover + a11y.
		const links = w.findAll('a');
		expect(links[0].attributes('title')).toBe('inbox');
		expect(links[0].attributes('aria-label')).toContain('inbox');
		expect(links[0].attributes('aria-label')).toContain('4 unread');
		// Unread count still surfaced as a badge.
		expect(w.text()).toContain('4');
	});

	it('re-expands to labelled rows when collapsed flips back to false', async () => {
		const w = mountList(true);
		expect(w.text().toLowerCase()).not.toContain('inbox');
		await w.setProps({ collapsed: false });
		expect(w.text()).toContain('inbox');
		expect(w.text()).toContain('sent');
	});
});
