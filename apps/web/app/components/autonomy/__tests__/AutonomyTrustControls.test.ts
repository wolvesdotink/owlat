// @vitest-environment happy-dom
/**
 * Autonomy trust-control components render + emit the right actions.
 *
 *   - AutonomyKillSwitch: renders the stop control, reveals a confirm step, and
 *     emits `confirm` only once the operator confirms.
 *   - AutonomyGraduationNudge: renders an actionable offer for a graduated
 *     slice, emits `accept-offer` with the (category, sender), and renders
 *     NOTHING when there is nothing to graduate.
 *
 * Global UI auto-imports (UiCard/UiIconBox/UiToggle/Icon) are stubbed; `ref`/
 * `computed` are polyfilled by the web vitest setup.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

import AutonomyKillSwitch from '../AutonomyKillSwitch.vue';
import AutonomyGraduationNudge from '../AutonomyGraduationNudge.vue';

const stubs = {
	Icon: true,
	UiCard: { template: '<div><slot /></div>' },
	UiIconBox: true,
	UiToggle: true,
};
const mountOpts = { global: { stubs } };

describe('AutonomyKillSwitch', () => {
	it('renders the stop control and emits confirm only after confirmation', async () => {
		const wrapper = mount(AutonomyKillSwitch, mountOpts);
		expect(wrapper.text()).toContain('Stop auto-sending');

		// No confirm emitted from just opening.
		await wrapper.get('[data-testid="kill-switch-open"]').trigger('click');
		expect(wrapper.emitted('confirm')).toBeUndefined();

		// Confirming emits exactly once.
		await wrapper.get('[data-testid="kill-switch-confirm"]').trigger('click');
		expect(wrapper.emitted('confirm')).toHaveLength(1);
	});

	it('disables the confirm control while busy', () => {
		const wrapper = mount(AutonomyKillSwitch, { ...mountOpts, props: { busy: true } });
		// The open button is disabled while a kill switch is in flight.
		expect(wrapper.get('[data-testid="kill-switch-open"]').attributes('disabled')).toBeDefined();
	});
});

describe('AutonomyGraduationNudge', () => {
	it('renders a graduated offer and emits accept-offer with the slice key', async () => {
		const wrapper = mount(AutonomyGraduationNudge, {
			...mountOpts,
			props: {
				offers: [
					{
						category: 'support',
						sender: 'vip@acme.com',
						wouldHaveSent: 20,
						matched: 20,
						matchRate: 1,
						offerGraduation: true,
					},
				],
				suggestions: [],
			},
		});

		expect(wrapper.find('[data-testid="graduation-nudge"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('vip@acme.com');
		expect(wrapper.text()).toContain('enable auto-send');

		await wrapper.get('[data-testid="graduation-offer"] button').trigger('click');
		const events = wrapper.emitted('accept-offer');
		expect(events).toHaveLength(1);
		expect(events![0]![0]).toEqual({ category: 'support', sender: 'vip@acme.com' });
	});

	it('renders NOTHING when there is nothing to graduate', () => {
		const wrapper = mount(AutonomyGraduationNudge, {
			...mountOpts,
			props: {
				// An unearned slice (offerGraduation:false) is not shown.
				offers: [
					{
						category: 'support',
						sender: 'x@y.com',
						wouldHaveSent: 2,
						matched: 1,
						matchRate: 0.5,
						offerGraduation: false,
					},
				],
				suggestions: [],
			},
		});
		expect(wrapper.find('[data-testid="graduation-nudge"]').exists()).toBe(false);
	});
});
