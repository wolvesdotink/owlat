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

const DAY = 24 * 3_600_000;

// Sent a week ago and finished at the end of its window, so the comparison is due.
function mountCard(campaign: Record<string, unknown>) {
	const sentAt = Date.now() - 7 * DAY;
	return mount(CampaignSendTimeReport, {
		props: {
			campaign: {
				status: 'sent',
				sentAt,
				updatedAt: sentAt + DAY,
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
			statsSendTimeOptimizedDelivered: 900,
			statsSendTimeHoldoutDelivered: 40,
		});
		expect(wrapper.find('[data-state="too-early"]').text()).toContain(
			'so far 900 optimized and 40 at the start time'
		);
		expectFullyLocalized(wrapper);
	});

	it('calls nothing while sends are still landing, even with lopsided counts', () => {
		const counts = {
			statsSendTimeOptimizedDelivered: 2000,
			statsSendTimeOptimizedOpened: 200,
			statsSendTimeHoldoutDelivered: 2000,
			statsSendTimeHoldoutOpened: 700,
		};
		const sending = mountCard({ ...counts, status: 'sending' });
		expect(sending.find('[data-state="measuring"]').text()).toContain(
			'a day after the last email goes out'
		);
		expect(sending.find('[data-metric]').exists()).toBe(false);
		expect(sending.text()).toContain('Still sending');
		expectFullyLocalized(sending);

		const justSent = mountCard({ ...counts, sentAt: Date.now() - DAY, updatedAt: Date.now() });
		expect(justSent.find('[data-state="measuring"]').text()).toContain(
			'The comparison is ready on'
		);
		expect(justSent.find('[data-metric]').exists()).toBe(false);
		expectFullyLocalized(justSent);
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
