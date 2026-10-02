// @vitest-environment happy-dom
/**
 * The delivery-time choice on the schedule panels: the three modes, the
 * optimizer's window and comparison group, and the A/B test guard.
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { Id } from '@owlat/api/dataModel';

import SendTimingOptions from '../SendTimingOptions.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import { defaultSendTiming, type SendTiming } from '~/lib/sendTiming';

Object.assign(globalThis, i18nStubs);

const CAMPAIGN_ID = 'campaign_1' as Id<'campaigns'>;

const selectStub = {
	props: ['modelValue', 'options', 'label'],
	emits: ['update:modelValue'],
	template:
		'<label class="select-stub">{{ label }}<span v-for="o in options" :key="o.value" class="option" @click="$emit(\'update:modelValue\', o.value)">{{ o.label }}</span></label>',
};

function mountOptions(modelValue: SendTiming, extra: Record<string, unknown> = {}) {
	return mount(SendTimingOptions, {
		props: {
			modelValue,
			time: '09:30',
			campaignId: CAMPAIGN_ID,
			startAt: Date.UTC(2026, 2, 11, 9, 30),
			...extra,
		},
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: true, UiSelect: selectStub, CampaignsSendTimeDistribution: true },
		},
	});
}

describe('SendTimingOptions', () => {
	it('offers the three delivery times, with the start time in the copy', () => {
		const wrapper = mountOptions(defaultSendTiming('fixed'));
		const text = wrapper.text();
		expect(text).toContain('Same moment for everyone');
		expect(text).toContain("Recipient's local time");
		expect(text).toContain('Optimized per contact');
		expect(text).toContain('Everyone gets the email at 09:30 in your time zone.');
		expect(wrapper.find('[data-testid="send-timing-optimized"]').exists()).toBe(false);
		expectFullyLocalized(wrapper);
	});

	it('switches mode without dropping the optimizer settings', async () => {
		const wrapper = mountOptions({ mode: 'fixed', windowHours: 12, holdoutPercent: 5 });
		await wrapper.find('[data-mode="optimized"] input').trigger('change');
		expect(wrapper.emitted('update:modelValue')).toEqual([
			[{ mode: 'optimized', windowHours: 12, holdoutPercent: 5 }],
		]);
	});

	it('shows the window, the comparison group and the prediction once optimized', async () => {
		const wrapper = mountOptions(defaultSendTiming('optimized'));
		const panel = wrapper.find('[data-testid="send-timing-optimized"]');
		expect(panel.exists()).toBe(true);
		expect(panel.text()).toContain('Send window');
		expect(panel.text()).toContain('Within 72 hours');
		expect(panel.text()).toContain('20% at the start time');
		expect(panel.text()).toContain('None');
		expect(wrapper.find('campaigns-send-time-distribution-stub').attributes()).toMatchObject({
			'window-hours': '24',
			'holdout-percent': '10',
		});

		const [windowSelect, holdoutSelect] = wrapper.findAll('.select-stub');
		await windowSelect!.findAll('.option')[3]!.trigger('click');
		await holdoutSelect!.findAll('.option')[0]!.trigger('click');
		expect(wrapper.emitted('update:modelValue')).toEqual([
			[{ mode: 'optimized', windowHours: 48, holdoutPercent: 10 }],
			[{ mode: 'optimized', windowHours: 24, holdoutPercent: 0 }],
		]);
		expectFullyLocalized(wrapper);
	});

	it('keeps optimization off for an A/B test and says why', () => {
		const wrapper = mountOptions(defaultSendTiming('fixed'), { isAbTest: true });
		const optimized = wrapper.find('[data-mode="optimized"]');
		expect(optimized.find('input').attributes('disabled')).toBeDefined();
		expect(optimized.text()).toContain('Not available for A/B tests');
	});

	it('shows an empty clock while no time is picked', () => {
		const wrapper = mountOptions(defaultSendTiming('local'), { time: '' });
		expect(wrapper.text()).toContain('at --:-- in their own time zone');
	});
});
