/**
 * The tri-state feature switch is a checkbox to assistive tech, so a partial
 * pack is announced as mixed rather than as off. Clicking only emits `toggle`:
 * what that does from each state is the parent's call (see FeaturePackList).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import FeatureToggleSwitch from '../FeatureToggleSwitch.vue';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

function mountSwitch(state: 'on' | 'off' | 'partial', disabled = false) {
	return mount(FeatureToggleSwitch, {
		props: { state, label: 'AI', disabled },
		global: { plugins: [createTestI18n()] },
	});
}

describe('FeatureToggleSwitch', () => {
	it.each([
		['off', 'false'],
		['partial', 'mixed'],
		['on', 'true'],
	] as const)('reports %s as aria-checked="%s" on a checkbox', (state, ariaChecked) => {
		const button = mountSwitch(state).get('button');
		expect(button.attributes('role')).toBe('checkbox');
		expect(button.attributes('aria-checked')).toBe(ariaChecked);
		expect(button.attributes('aria-label')).toBe('Toggle AI');
	});

	it.each(['off', 'partial', 'on'] as const)('emits toggle on click from %s', async (state) => {
		const wrapper = mountSwitch(state);
		await wrapper.get('button').trigger('click');
		expect(wrapper.emitted('toggle')).toEqual([[]]);
	});

	it('does not emit while disabled', async () => {
		const wrapper = mountSwitch('partial', true);
		await wrapper.get('button').trigger('click');
		expect(wrapper.emitted('toggle')).toBeUndefined();
	});
});
