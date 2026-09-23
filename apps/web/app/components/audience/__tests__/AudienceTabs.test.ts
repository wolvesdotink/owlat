// @vitest-environment happy-dom
/**
 * Audience is one section with tabs (#787): the old overview's stat tiles
 * became the tab counts, and topics/segments stay admin-only as in the sidebar.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';

import AudienceTabs from '../AudienceTabs.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { installNuxtStubs, queryResult } from '~/__tests__/a11y';

let path = '/dashboard/audience/contacts';
let isAdmin = true;

beforeEach(() => {
	path = '/dashboard/audience/contacts';
	isAdmin = true;
});

function render() {
	installNuxtStubs({
		...i18nStubs,
		useRoute: () => ({ path, query: {}, params: {} }),
		usePermissions: () => ({ isAdmin: ref(isAdmin) }),
		useOrganizationQuery: () =>
			queryResult({ totalContacts: 12480, topicCount: 3, segmentCount: 2 }),
	});
	return mount(AudienceTabs, { global: { plugins: [createTestI18n()] } });
}

describe('AudienceTabs', () => {
	it('lists the four audience views with the counts the overview tiles had', () => {
		const wrapper = render();
		const tabs = wrapper.findAll('a');
		expect(tabs.map((a) => a.attributes('href'))).toEqual([
			'/dashboard/audience/contacts',
			'/dashboard/audience/topics',
			'/dashboard/audience/segments',
			'/dashboard/audience/suppressions',
		]);
		expect(tabs.map((a) => a.text().replace(/\s+/g, ' '))).toEqual([
			'Contacts 12,480',
			'Topics 3',
			'Segments 2',
			'Suppressions',
		]);
	});

	it('marks the current view, including its detail pages', () => {
		path = '/dashboard/audience/topics/topic_1';
		const wrapper = render();
		const current = wrapper.findAll('a[aria-current="page"]');
		expect(current).toHaveLength(1);
		expect(current[0]!.attributes('data-tab')).toBe('topics');
	});

	it('hides the admin-only topics and segments from members', () => {
		isAdmin = false;
		const wrapper = render();
		expect(wrapper.findAll('a').map((a) => a.attributes('data-tab'))).toEqual([
			'contacts',
			'suppressions',
		]);
	});
});
