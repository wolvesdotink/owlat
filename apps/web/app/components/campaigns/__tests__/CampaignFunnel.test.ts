// @vitest-environment happy-dom
/**
 * The report funnel: five steps in order, each with its count, the share of
 * the step before it, and the exact numbers in its hover title.
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

	it('shows each step as a share of the step before it', () => {
		const wrapper = render({
			sent: 1000,
			delivered: 980,
			opened: 490,
			clicked: 49,
			unsubscribed: 0,
		});
		const [sent, delivered, opened, clicked] = wrapper.findAll('li');
		expect(sent!.text()).not.toContain('of previous');
		expect(delivered!.text()).toContain('98.0% of previous');
		expect(opened!.text()).toContain('50.0% of previous');
		expect(clicked!.text()).toContain('10.0% of previous');
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
		expect(wrapper.text()).not.toContain('of previous');
	});
});
