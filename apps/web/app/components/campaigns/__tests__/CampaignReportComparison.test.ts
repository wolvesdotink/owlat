// @vitest-environment happy-dom
/**
 * The report's single comparison row (#784): open and click rate with their
 * change in points against the previous campaign, and nothing about counts.
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';

import CampaignReportComparison from '../CampaignReportComparison.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

Object.assign(globalThis, i18nStubs);

const CURRENT = { sent: 12480, delivered: 12381, opened: 4755, clicked: 770, bounced: 99 };
const PREVIOUS = {
	name: 'Partner spotlight',
	sent: 10000,
	delivered: 10000,
	opened: 3350,
	clicked: 340,
	bounced: 0,
};

function render(props: {
	previous: typeof PREVIOUS | null;
	isABTest?: boolean;
	pending?: boolean;
}) {
	return mount(CampaignReportComparison, {
		props: {
			current: CURRENT,
			previous: props.previous,
			isABTest: props.isABTest ?? false,
			pending: props.pending ?? false,
		},
		global: { plugins: [createTestI18n()] },
	});
}

describe('CampaignReportComparison', () => {
	it('names the previous campaign once and gives both rates a points change', () => {
		const wrapper = render({ previous: PREVIOUS });
		expect(wrapper.find('[data-part="lead"]').text()).toBe('Compared with Partner spotlight:');
		const open = wrapper.find('[data-rate="openRate"]').text();
		const click = wrapper.find('[data-rate="clickRate"]').text();
		// 4755 / 12381 = 38.4%, previous 33.5% → +4.9 pts
		expect(open).toContain('Open rate');
		expect(open).toContain('38.4%');
		expect(open).toContain('+4.9 pts');
		// 770 / 12381 = 6.2%, previous 3.4% → +2.8 pts
		expect(click).toContain('Click rate');
		expect(click).toContain('6.2%');
		expect(click).toContain('+2.8 pts');
	});

	it('never puts a points change on a count', () => {
		const text = render({ previous: PREVIOUS }).text();
		expect(text).not.toContain('Delivered');
		expect(text).not.toContain('Bounced');
		expect(text.match(/pts/g)).toHaveLength(2);
	});

	it('shows a drop with a minus sign and an unchanged rate as "no change"', () => {
		const wrapper = render({
			previous: { ...PREVIOUS, opened: 4755 * (10000 / 12381), clicked: 1000 },
		});
		expect(wrapper.find('[data-rate="openRate"]').text()).toContain('no change');
		expect(wrapper.find('[data-rate="clickRate"]').text()).toContain('−3.8 pts');
	});

	it('says which kind of send it compared with for an A/B test', () => {
		const wrapper = render({ previous: PREVIOUS, isABTest: true });
		expect(wrapper.find('[data-part="lead"]').text()).toBe(
			'Compared with your previous A/B test, Partner spotlight:'
		);
	});

	it('shows the rates alone when there is nothing to compare with', () => {
		const wrapper = render({ previous: null });
		expect(wrapper.find('[data-part="lead"]').exists()).toBe(false);
		expect(wrapper.text()).toContain('38.4%');
		expect(wrapper.text()).not.toContain('pts');
		expect(wrapper.text()).toContain('No earlier campaign to compare with yet.');
	});

	it('explains live numbers instead of comparing them while the send is pending', () => {
		const wrapper = render({ previous: PREVIOUS, pending: true });
		expect(wrapper.text()).toBe('These fill in as the send goes out.');
	});
});
