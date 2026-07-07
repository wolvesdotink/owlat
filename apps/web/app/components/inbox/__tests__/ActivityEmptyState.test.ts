// @vitest-environment happy-dom
/**
 * Guided empty state for the All-activity feed:
 *   - always renders the "channel connected" explanation (every role)
 *   - shows the "Connect a channel" CTA ONLY for admins (canManage) — an editor
 *     never sees an affordance that would 403 on the settings mutation
 *   - the CTA links to Settings → Messaging channels
 *   - a channel filter narrows the title but keeps the guidance
 *
 * NuxtLink + the Ui* globals are stubbed (global auto-imports); the CTA is
 * matched by its test id so a stubbed NuxtLink still asserts presence/href.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

import ActivityEmptyState from '../ActivityEmptyState.vue';

const mountOpts = {
	global: {
		stubs: {
			Icon: true,
			UiIconBox: true,
			NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
		},
	},
};

describe('ActivityEmptyState', () => {
	it('shows the connect-a-channel CTA to admins, linking to Messaging channels', () => {
		const wrapper = mount(ActivityEmptyState, { ...mountOpts, props: { canManage: true } });
		const cta = wrapper.find('[data-testid="connect-channel-cta"]');
		expect(cta.exists()).toBe(true);
		expect(cta.attributes('href')).toBe('/dashboard/settings/channels');
		expect(wrapper.text()).toContain('once a channel is connected');
	});

	it('hides the CTA for non-admins but keeps the explanation', () => {
		const wrapper = mount(ActivityEmptyState, { ...mountOpts, props: { canManage: false } });
		expect(wrapper.find('[data-testid="connect-channel-cta"]').exists()).toBe(false);
		expect(wrapper.text()).toContain('once a channel is connected');
	});

	it('narrows the title to the active channel filter', () => {
		const wrapper = mount(ActivityEmptyState, {
			...mountOpts,
			props: { canManage: true, filterLabel: 'SMS' },
		});
		expect(wrapper.text()).toContain('No SMS messages yet');
	});

	it('shows the generic title when no filter is active', () => {
		const wrapper = mount(ActivityEmptyState, { ...mountOpts, props: { canManage: true } });
		expect(wrapper.text()).toContain('No messages yet');
	});
});
