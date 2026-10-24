/**
 * Reset on a stream's ramp pace. "Default" here is inheritance: a stream with no
 * stored pace follows the deployment default, so the marker shows for ANY
 * stored pace (one equal to today's default included, it would not follow a
 * later change of default) and Reset asks for `null`, exactly like choosing
 * "Use the default".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import RampPresetPicker from '../RampPresetPicker.vue';

beforeEach(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

function mountPicker(preset: 'conservative' | 'balanced' | null, busy = false) {
	return mount(RampPresetPicker, {
		props: {
			stream: 'campaign',
			preset,
			defaultPreset: 'balanced',
			hasReferenceArm: true,
			busy,
		},
		global: { plugins: [createTestI18n()] },
	});
}

describe('RampPresetPicker: reset to default', () => {
	it('offers no reset while the stream follows the deployment default', () => {
		expect(mountPicker(null).find('[data-testid="setting-reset"]').exists()).toBe(false);
	});

	it('offers reset for a stored pace, even one equal to the current default', () => {
		expect(mountPicker('conservative').find('[data-testid="setting-reset"]').exists()).toBe(true);
		expect(mountPicker('balanced').find('[data-testid="setting-reset"]').exists()).toBe(true);
	});

	it('asks for the inherited default, not a pace', async () => {
		const wrapper = mountPicker('conservative');
		await wrapper.get('[data-testid="setting-reset"] button').trigger('click');
		expect(wrapper.emitted('change')).toEqual([[null]]);
	});

	it('keeps the reset out of the group name', () => {
		const wrapper = mountPicker('conservative');
		const legend = wrapper.get('legend');
		expect(legend.text()).toBe('Campaign mail');
		expect(legend.find('button').exists()).toBe(false);
	});

	it('holds the reset while a pace is being written', () => {
		const wrapper = mountPicker('conservative', true);
		expect(
			wrapper.get('[data-testid="setting-reset"] button').attributes('disabled')
		).toBeDefined();
	});
});
