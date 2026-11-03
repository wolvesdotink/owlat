/**
 * The Review step's summary and send options: each summary row shows what the
 * earlier steps set and its pencil goes back to the step that sets it, the A/B
 * row names both variants, the split and the winner rule, and the schedule
 * inputs feed the preview of when the send starts. Sending itself is pinned in
 * `ReviewStepSend.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';

import ReviewStep from '../steps/ReviewStep.vue';
import { useCapacityRefusal } from '~/composables/useCapacityRefusal';
import { useModal } from '~/composables/useModal';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const CAMPAIGN_ID = 'campaign_1' as Id<'campaigns'>;
const TEMPLATE = { _id: 'tpl_1' as Id<'emailTemplates'>, name: 'Digest', subject: 'Hi' };
const VARIANT_B = {
	_id: 'tpl_b' as Id<'emailTemplates'>,
	name: 'Digest, long form',
	subject: 'Hi',
};

const passthroughStub = defineComponent({
	setup(_props, { slots }) {
		return () => h('div', slots.default?.());
	},
});

// The delivery-time picker, reduced to one button per mode.
const timingStub = defineComponent({
	props: { modelValue: { type: Object, required: true } },
	emits: ['update:modelValue'],
	setup(props, { emit }) {
		return () =>
			h(
				'div',
				['instant', 'local', 'optimized'].map((mode) =>
					h(
						'button',
						{
							'data-testid': `timing-${mode}`,
							onClick: () => emit('update:modelValue', { ...props.modelValue, mode }),
						},
						mode
					)
				)
			);
	},
});

const errorAlertStub = defineComponent({
	props: { message: String },
	emits: ['action'],
	setup(props, { emit }) {
		return () =>
			h('div', { 'data-testid': 'error-alert' }, [
				props.message,
				h('button', { 'data-testid': 'error-alert-action', onClick: () => emit('action') }),
			]);
	},
});

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-03-10T09:00:00'));
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useRouter', () => ({ push: vi.fn() }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useCapacityRefusal', useCapacityRefusal);
	vi.stubGlobal('useModal', useModal);
	vi.stubGlobal('usePresendChecks', () => ({
		checks: ref([]),
		summary: ref({ warnings: 0, blocking: 0, pending: 0, signature: '' }),
		isChecking: ref(false),
		run: vi.fn(),
	}));
	vi.stubGlobal('useOrganizationQuery', () => ({ data: ref(undefined) }));
	vi.stubGlobal('useCampaignUndoSend', () => ({ arm: vi.fn() }));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn() }));
});

function mountStep(overrides: Partial<Record<string, unknown>> = {}) {
	return mount(ReviewStep, {
		props: {
			data: {
				campaignId: CAMPAIGN_ID,
				campaignName: 'Weekly digest #34',
				fromName: 'Ada',
				fromEmail: 'ada@owlat.example',
				replyTo: 'team@owlat.example',
				audienceDisplayText: 'Topic: Product news',
				audienceCount: 1284,
				campaignSubject: 'What shipped this week',
				selectedTemplate: TEMPLATE,
				emailBodyHtml: '<p>Hi</p>',
				abTestEnabled: false,
				abTestType: 'subject',
				abVariantBSubject: '',
				abVariantBTemplateId: null,
				abSplitPercentage: 20,
				abWinnerCriteria: 'open_rate',
				abTestDuration: 4,
				templates: [TEMPLATE, VARIANT_B],
				...overrides,
			},
		},
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiConfirmationDialog: true,
				UiErrorAlert: errorAlertStub,
				UiIconBox: true,
				CampaignsCapacitySchedulePanel: true,
				CampaignsSendReadinessNote: true,
				CampaignsTestEmailModal: true,
				CampaignsEmailBodyPreview: true,
				CampaignsChangedSinceLastSend: true,
				CampaignsPresendChecksPanel: true,
				CampaignsSendTimingOptions: timingStub,
				I18nT: passthroughStub,
			},
		},
	});
}

const pencils = (wrapper: ReturnType<typeof mountStep>) =>
	wrapper.findAll('button').filter((b) => b.attributes('aria-label') === 'Edit');

describe('ReviewStep summary', () => {
	it('shows what the earlier steps set, and each pencil goes back to its step', async () => {
		const wrapper = mountStep();
		const text = wrapper.text();
		for (const line of [
			'Weekly digest #34',
			'ada@owlat.example',
			'Reply-to: team@owlat.example',
			'Topic: Product news',
			'What shipped this week',
			'Digest',
		]) {
			expect(text).toContain(line);
		}

		const buttons = pencils(wrapper);
		expect(buttons).toHaveLength(4);
		for (const button of buttons) await button.trigger('click');
		expect(wrapper.emitted('editStep')).toEqual([['setup'], ['setup'], ['setup'], ['content']]);
	});

	it('names both subject lines, the split and the winner rule of an A/B test', async () => {
		const wrapper = mountStep({
			abTestEnabled: true,
			abVariantBSubject: 'What shipped, in one minute',
			abWinnerCriteria: 'click_rate',
			abTestDuration: 6,
		});
		const text = wrapper.text();
		expect(text).toContain('Testing subject lines');
		expect(text).toContain('What shipped, in one minute');
		expect(text).toContain('20% each for test, winner sent to remaining 60%');
		expect(text).toContain('Winner by: Best click rate (after 6h)');

		const buttons = pencils(wrapper);
		expect(buttons).toHaveLength(5);
		await buttons[4]!.trigger('click');
		expect(wrapper.emitted('editStep')).toEqual([['setup']]);
	});

	it("names Variant B's template, and retries a template list that failed", async () => {
		const wrapper = mountStep({
			abTestEnabled: true,
			abTestType: 'content',
			abVariantBTemplateId: VARIANT_B._id,
			abWinnerCriteria: 'manual',
			templatesLoadFailed: true,
		});
		const text = wrapper.text();
		expect(text).toContain('Testing email templates');
		expect(text).toContain('Digest, long form');
		expect(text).toContain('Winner by: Manual selection');

		await wrapper.find('[data-testid="error-alert-action"]').trigger('click');
		expect(wrapper.emitted('retryTemplates')).toHaveLength(1);
	});
});

describe('ReviewStep schedule preview', () => {
	it('previews the start for each delivery-time mode', async () => {
		const wrapper = mountStep();
		expect(wrapper.find('input[type="date"]').exists()).toBe(false);

		await wrapper.findAll('input[type="radio"]')[1]!.setValue();
		await wrapper.find('input[type="date"]').setValue('2026-03-11');
		await wrapper.find('input[type="time"]').setValue('09:30');
		expect(wrapper.text()).toContain('Your campaign will be sent:');
		expect(wrapper.text()).toContain('March 11, 2026');

		await wrapper.find('[data-testid="timing-local"]').trigger('click');
		expect(wrapper.text()).toContain("09:30 in each recipient's timezone");

		await wrapper.find('[data-testid="timing-optimized"]').trigger('click');
		expect(wrapper.text()).toContain('Your campaign starts sending:');
		expect(wrapper.text()).toContain('Each contact gets it at their usual hour within');
	});
});
