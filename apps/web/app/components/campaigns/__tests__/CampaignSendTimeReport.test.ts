// @vitest-environment happy-dom
/**
 * The report's send-time card: the comparison is shown only when it is
 * honest, and a difference is only called when it is beyond chance.
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';

import CampaignSendTimeReport from '../CampaignSendTimeReport.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

Object.assign(globalThis, i18nStubs);

function mountCard(campaign: Record<string, unknown>) {
	return mount(CampaignSendTimeReport, {
		props: {
			campaign: {
				status: 'sent',
				sendTimeOptimization: { windowHours: 24, holdoutPercent: 10 },
				...campaign,
			},
		},
		global: { plugins: [createTestI18n()], stubs: { UiIconBox: true } },
	});
}

describe('CampaignSendTimeReport', () => {
	it('names the window and the comparison group', () => {
		const wrapper = mountCard({});
		expect(wrapper.text()).toContain('within 24 hours of the start');
		expect(wrapper.text()).toContain('10% got it at the start time for comparison');
		expectFullyLocalized(wrapper);
	});

	it('waits for enough delivered mail in both groups', () => {
		const wrapper = mountCard({
			status: 'sending',
			statsSendTimeOptimizedDelivered: 900,
			statsSendTimeHoldoutDelivered: 40,
		});
		expect(wrapper.find('[data-state="too-early"]').text()).toContain(
			'so far 900 optimized and 40 at the start time'
		);
		expect(wrapper.text()).toContain('Still sending');
		expectFullyLocalized(wrapper);
	});

	it('has nothing to compare without a comparison group', () => {
		const wrapper = mountCard({
			sendTimeOptimization: { windowHours: 12, holdoutPercent: 0 },
			statsSendTimeOptimizedDelivered: 900,
		});
		expect(wrapper.find('[data-state="no-holdout"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('within 12 hours of the start.');
	});

	it('shows both rates, the change and the verdict', () => {
		const wrapper = mountCard({
			statsSendTimeOptimizedDelivered: 9000,
			statsSendTimeOptimizedOpened: 3600,
			statsSendTimeOptimizedClicked: 540,
			statsSendTimeHoldoutDelivered: 1000,
			statsSendTimeHoldoutOpened: 330,
			statsSendTimeHoldoutClicked: 58,
		});
		const open = wrapper.find('[data-metric="openRate"]').text();
		expect(open).toContain('40.0%');
		expect(open).toContain('33.0%');
		expect(open).toContain('+7.0 pts');
		expect(open).toContain('Higher, beyond chance');
		const click = wrapper.find('[data-metric="clickRate"]').text();
		expect(click).toContain('No clear difference');
		expect(wrapper.text()).toContain('Optimized (9,000)');
		expect(wrapper.text()).toContain('Start time (1,000)');
		expectFullyLocalized(wrapper);
	});
});
