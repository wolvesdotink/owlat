// @vitest-environment happy-dom
/**
 * The lines under the open and click counts that say what they leave out
 * (#764, #831): the automated opens and clicks counted apart, or a caveat for
 * counts from before the split existed.
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';

import CampaignAutomatedEngagementNote from '../CampaignAutomatedEngagementNote.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

Object.assign(globalThis, i18nStubs);

function render(
	props: Partial<{
		automatedOpens: number;
		isAutomatedOpenFiltered: boolean;
		automatedClicks: number;
		isAutomatedClickFiltered: boolean;
	}>
) {
	return mount(CampaignAutomatedEngagementNote, {
		props: {
			automatedOpens: 0,
			isAutomatedOpenFiltered: true,
			automatedClicks: 0,
			isAutomatedClickFiltered: true,
			...props,
		},
		global: { plugins: [createTestI18n()], stubs: { Icon: true } },
	});
}

describe('CampaignAutomatedEngagementNote', () => {
	it('names how many emails were fetched automatically', () => {
		const wrapper = render({ automatedOpens: 1204 });
		expect(wrapper.text()).toContain('1,204 emails were fetched automatically');
		expect(wrapper.text()).toContain('not counted as opens');
		expect(wrapper.text()).toContain('Apple Mail Privacy Protection');
	});

	it('uses the singular for one email', () => {
		const wrapper = render({ automatedOpens: 1 });
		expect(wrapper.text()).toContain('1 email was fetched automatically by');
	});

	it('names how many emails had their links followed automatically', () => {
		const wrapper = render({ automatedClicks: 212 });
		expect(wrapper.text()).toContain('212 emails had their links followed automatically');
		expect(wrapper.text()).toContain('not counted as clicks');
	});

	it('uses the singular for one clicked email', () => {
		const wrapper = render({ automatedClicks: 1 });
		expect(wrapper.text()).toContain('1 email had its links followed automatically');
	});

	it('renders nothing when there is nothing to explain', () => {
		const wrapper = render({});
		expect(wrapper.text()).toBe('');
		expect(wrapper.find('p').exists()).toBe(false);
	});

	it('warns that opens counted before the filter may include automated ones', () => {
		const wrapper = render({ isAutomatedOpenFiltered: false });
		expect(wrapper.text()).toContain('counted before automated opens were filtered out');
	});

	it('warns that clicks counted before the filter may include scanners', () => {
		const wrapper = render({ isAutomatedClickFiltered: false });
		expect(wrapper.text()).toContain('Clicks counted before automated clicks were filtered out');
	});

	it('gives one caveat when both opens and clicks predate the filter', () => {
		const wrapper = render({ isAutomatedOpenFiltered: false, isAutomatedClickFiltered: false });
		expect(wrapper.findAll('p')).toHaveLength(1);
		expect(wrapper.text()).toContain('Opens and clicks counted before automated ones');
	});

	it('shows every line for a period that mixes filtered and older campaigns', () => {
		const wrapper = render({
			automatedOpens: 30,
			automatedClicks: 4,
			isAutomatedClickFiltered: false,
		});
		expect(wrapper.findAll('p')).toHaveLength(3);
	});
});
