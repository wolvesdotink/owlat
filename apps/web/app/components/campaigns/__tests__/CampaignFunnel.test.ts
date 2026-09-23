// @vitest-environment happy-dom
/**
 * The report funnel: steps in order, each with its count, its rate against a
 * named base ("of delivered", never "of previous" — #784), and the exact
 * numbers in its hover title.
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';

import CampaignFunnel from '../CampaignFunnel.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

Object.assign(globalThis, i18nStubs);

function render(props: {
	sent: number;
	delivered: number;
	opened: number;
	clicked: number;
	unsubscribed: number;
	bounced?: number;
}) {
	return mount(CampaignFunnel, { props, global: { plugins: [createTestI18n()] } });
}

describe('CampaignFunnel', () => {
	it('lists the five steps in funnel order', () => {
		const wrapper = render({
			sent: 1000,
			delivered: 980,
			opened: 400,
			clicked: 60,
			unsubscribed: 3,
		});
		const steps = wrapper.findAll('li').map((li) => li.attributes('data-step'));
		expect(steps).toEqual(['sent', 'delivered', 'opened', 'clicked', 'unsubscribed']);
	});

	it('names the base of every rate instead of saying "of previous"', () => {
		const wrapper = render({
			sent: 1000,
			delivered: 980,
			opened: 490,
			clicked: 49,
			unsubscribed: 0,
		});
		const [sent, delivered, opened, clicked] = wrapper.findAll('li');
		expect(sent!.text()).not.toContain('%');
		expect(delivered!.text()).toContain('98.0% of sent');
		expect(opened!.text()).toContain('50.0% of delivered');
		expect(clicked!.text()).toContain('10.0% of opened');
		expect(wrapper.text()).not.toContain('of previous');
	});

	it('measures unsubscribes against delivered, not against clicks', () => {
		const wrapper = render({
			sent: 1000,
			delivered: 1000,
			opened: 500,
			clicked: 10,
			unsubscribed: 5,
		});
		expect(wrapper.find('[data-step="unsubscribed"]').text()).toContain('0.5% of delivered');
	});

	it('adds a bounced row measured against sent when bounces are passed', () => {
		const without = render({ sent: 100, delivered: 98, opened: 0, clicked: 0, unsubscribed: 0 });
		expect(without.find('[data-step="bounced"]').exists()).toBe(false);
		const withBounces = render({
			sent: 100,
			delivered: 98,
			opened: 0,
			clicked: 0,
			unsubscribed: 0,
			bounced: 2,
		});
		const bounced = withBounces.find('[data-step="bounced"]');
		expect(bounced.text()).toContain('Bounced');
		expect(bounced.text()).toContain('2.0% of sent');
	});

	it('carries the exact numbers in the hover title', () => {
		const wrapper = render({
			sent: 1000,
			delivered: 980,
			opened: 490,
			clicked: 49,
			unsubscribed: 2,
		});
		const opened = wrapper.find('[data-step="opened"]');
		expect(opened.attributes('title')).toBe('Opened: 490 of 980 (Delivered)');
	});

	it('does not divide by zero before anything was delivered', () => {
		const wrapper = render({ sent: 0, delivered: 0, opened: 0, clicked: 0, unsubscribed: 0 });
		expect(wrapper.text()).not.toContain('NaN');
		expect(wrapper.text()).not.toContain('%');
	});
});
