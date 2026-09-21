// @vitest-environment happy-dom
/**
 * `pill` is the one shape switch the badge has: the status pills in the app
 * (send status, code-task status) are fully rounded, every other badge keeps
 * the small radius. Pinned so the two shapes cannot drift into a third recipe
 * hand-rolled beside the component.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import Badge from '../components/ui/Badge.vue';

describe('Badge', () => {
	it('keeps the small radius by default', () => {
		const wrapper = mount(Badge, { slots: { default: 'Sent' } });
		expect(wrapper.classes()).toContain('rounded');
		expect(wrapper.classes()).not.toContain('rounded-full');
	});

	it('renders fully rounded ends as a pill', () => {
		const wrapper = mount(Badge, { props: { pill: true }, slots: { default: 'Sent' } });
		expect(wrapper.classes()).toContain('rounded-full');
		expect(wrapper.classes()).not.toContain('rounded');
	});

	it('places the icon slot before the label', () => {
		const wrapper = mount(Badge, {
			props: { pill: true, variant: 'success' },
			slots: { icon: '<i data-icon />', default: 'Delivered' },
		});
		const html = wrapper.html();
		expect(html.indexOf('data-icon')).toBeLessThan(html.indexOf('Delivered'));
		expect(wrapper.classes()).toContain('text-success');
	});
});
