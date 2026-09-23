// @vitest-environment happy-dom
/**
 * A disabled Next says what is missing (#785): "Still needed: a campaign name,
 * a sender and recipients", shrinking as each part is filled in, and gone once
 * Next can work.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref, type Ref } from 'vue';

import SetupStep from '../SetupStep.vue';
import SetupAudiencePicker from '../SetupAudiencePicker.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { installNuxtStubs, paginatedResult } from '~/__tests__/a11y';
import { useFormValidation } from '~/composables/useFormValidation';
import { useModal } from '~/composables/useModal';
import { useCampaignABTest } from '~/composables/useCampaignABTest';

let senderReady: Ref<boolean>;

/** The sender picker's contract with the step: `isReady` + `validate()`. */
const SenderPickerStub = defineComponent({
	name: 'CampaignsStepsSetupSenderPicker',
	setup(_, { expose }) {
		expose({
			get isReady() {
				return senderReady.value;
			},
			validate: () => null,
		});
		return () => h('div');
	},
});

beforeEach(() => {
	senderReady = ref(false);
	installNuxtStubs({
		...i18nStubs,
		useFormValidation,
		useModal,
		useCampaignABTest,
		useTopicsList: () =>
			paginatedResult([{ _id: 'topic_1', name: 'Newsletter', contactCount: 12 }]),
	});
});

function mountStep(): VueWrapper {
	return mount(SetupStep, {
		props: { campaignId: null },
		global: {
			plugins: [createTestI18n()],
			components: {
				CampaignsStepsSetupSenderPicker: SenderPickerStub,
				CampaignsStepsSetupAudiencePicker: SetupAudiencePicker,
			},
			stubs: { UiErrorAlert: true, CampaignsABTestConfig: true, I18nT: true },
		},
	}) as VueWrapper;
}

function missing(wrapper: VueWrapper): string | null {
	const el = wrapper.find('[data-testid="setup-missing"]');
	return el.exists() ? el.text() : null;
}

function nextButton(wrapper: VueWrapper) {
	return wrapper.find('button[type="submit"]');
}

describe('SetupStep — what Next is waiting for', () => {
	it('lists every missing part next to the disabled button', () => {
		const wrapper = mountStep();
		expect(missing(wrapper)).toBe('Still needed: a campaign name, a sender, and recipients');
		expect(nextButton(wrapper).attributes('disabled')).toBeDefined();
		expect(nextButton(wrapper).attributes('aria-describedby')).toBe('setup-missing');
	});

	it('drops each part as it is filled in and enables Next at the end', async () => {
		const wrapper = mountStep();
		await wrapper.find('#campaignName').setValue('September newsletter');
		expect(missing(wrapper)).toBe('Still needed: a sender and recipients');

		senderReady.value = true;
		// `isReady` is read through the component ref; nudge a re-render.
		await wrapper.find('#campaignName').setValue('September newsletter ');
		expect(missing(wrapper)).toBe('Still needed: recipients');

		await wrapper.find('[data-testid="audience-picker"]').setValue('topic:topic_1');
		await nextTick();
		expect(missing(wrapper)).toBeNull();
		expect(nextButton(wrapper).attributes('disabled')).toBeUndefined();
	});
});
