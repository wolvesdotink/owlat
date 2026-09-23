// @vitest-environment happy-dom
/**
 * Autonomy trust-control components render + emit the right actions.
 *
 *   - AutonomyGraduationNudge: renders an actionable offer for a graduated
 *     slice, emits `accept-offer` with the (category, sender), and renders
 *     NOTHING when there is nothing to graduate.
 *
 * Global UI auto-imports (UiCard/UiIconBox/UiToggle/Icon) are stubbed; `ref`/
 * `computed` are polyfilled by the web vitest setup. Both components render
 * their copy through vue-i18n, so they are mounted against the REAL catalog —
 * the sentences asserted below are the ones a person actually reads.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';

import AutonomyGraduationNudge from '../AutonomyGraduationNudge.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const stubs = {
	Icon: true,
	UiCard: { template: '<div><slot /></div>' },
	UiIconBox: true,
	UiSpinner: true,
	UiToggle: true,
};
/** A fresh i18n instance per mount — locale state must not leak between them. */
const mountOpts = () => ({ global: { plugins: [createTestI18n()], stubs } });

describe('AutonomyGraduationNudge', () => {
	it('renders a graduated offer and emits accept-offer with the slice key', async () => {
		const wrapper = mount(AutonomyGraduationNudge, {
			...mountOpts(),
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
		expect(wrapper.text()).toContain('Match rate 100%');
		expectFullyLocalized(wrapper);

		await wrapper.get('[data-testid="graduation-offer"] button').trigger('click');
		const events = wrapper.emitted('accept-offer');
		expect(events).toHaveLength(1);
		expect(events![0]![0]).toEqual({ category: 'support', sender: 'vip@acme.com' });
	});

	it('renders NOTHING when there is nothing to graduate', () => {
		const wrapper = mount(AutonomyGraduationNudge, {
			...mountOpts(),
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
