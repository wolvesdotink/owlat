// @vitest-environment happy-dom
/**
 * Setup mounts fresh against a campaign that already exists whenever the
 * wizard's <KeepAlive> cache is gone: a refresh, or the return from the email
 * editor (#1048). The form then fills itself from the persisted campaign, and a
 * campaign read that lands after the user started typing never overwrites what
 * they typed.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ref, type Ref } from 'vue';
import { getFunctionName, type FunctionReference } from 'convex/server';

import SetupStep from '../SetupStep.vue';
import SetupAudiencePicker from '../SetupAudiencePicker.vue';
import SetupSenderPicker from '../SetupSenderPicker.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { installNuxtStubs, paginatedResult, queryResult } from '~/__tests__/a11y';
import { useFormValidation } from '~/composables/useFormValidation';
import { useModal } from '~/composables/useModal';
import { useCampaignABTest } from '~/composables/useCampaignABTest';

type PersistedCampaign = Record<string, unknown> | null | undefined;

let campaign: Ref<PersistedCampaign>;

const persisted = {
	_id: 'cmp1',
	name: 'Weekly digest',
	fromName: 'Example news',
	fromEmail: 'news@example.com',
	replyTo: 'replies@example.com',
	audience: { kind: 'segment', segmentId: 'seg_1' },
};

const SENDER = {
	_id: 'sender_1',
	email: 'news@example.com',
	displayName: 'Example news',
	isDefault: false,
	domainVerified: true,
	alignment: 'aligned' as const,
	alignmentReason: null,
};

beforeEach(() => {
	campaign = ref(undefined);
	installNuxtStubs({
		...i18nStubs,
		useFormValidation,
		useModal,
		useCampaignABTest,
		useConvexQuery: () => ({ ...queryResult(undefined), data: campaign }),
		useOrganizationQuery: (reference: FunctionReference<'query'>) =>
			getFunctionName(reference) === 'campaigns/senders:listForPicker'
				? queryResult({ senders: [SENDER], isCustomAllowed: false, canManage: true })
				: queryResult(undefined),
		useTopicsList: () => paginatedResult([{ _id: 'topic_1', name: 'Newsletter' }]),
		useOrganizationPaginatedQuery: () =>
			paginatedResult([{ _id: 'seg_1', name: 'Active readers' }]),
		useOrganization: () => ({ members: ref([]), fetchMembers: async () => {} }),
	});
});

function mountStep(): VueWrapper {
	return mount(SetupStep, {
		props: { campaignId: 'cmp1' as never },
		global: {
			plugins: [createTestI18n()],
			components: {
				CampaignsStepsSetupSenderPicker: SetupSenderPicker,
				CampaignsStepsSetupAudiencePicker: SetupAudiencePicker,
			},
			stubs: {
				UiErrorAlert: true,
				UiSelect: true,
				CampaignsSenderAuthChip: true,
				CampaignsStepsSetupAddSenderInline: true,
				CampaignsABTestConfig: true,
				I18nT: true,
			},
		},
	}) as VueWrapper;
}

const value = (wrapper: VueWrapper, selector: string) =>
	(wrapper.find(selector).element as HTMLInputElement).value;

describe('SetupStep against a persisted campaign', () => {
	it('restores every saved field and enables Next', async () => {
		campaign.value = persisted;
		const wrapper = mountStep();
		await flushPromises();

		expect(value(wrapper, '#campaignName')).toBe('Weekly digest');
		expect(value(wrapper, '#replyTo')).toBe('replies@example.com');
		expect(value(wrapper, '[data-testid="audience-picker"]')).toBe('segment:seg_1');
		const form = (wrapper.vm as unknown as { form: Record<string, string> }).form;
		expect(form).toMatchObject({ fromName: 'Example news', fromEmail: 'news@example.com' });
		expect(wrapper.find('[data-testid="setup-missing"]').exists()).toBe(false);
		expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeUndefined();
	});

	it('fills in once the campaign arrives, but keeps what the user already typed', async () => {
		const wrapper = mountStep();
		await flushPromises();

		await wrapper.find('#campaignName').setValue('Autumn digest');
		await wrapper.find('[data-testid="audience-picker"]').setValue('topic:topic_1');

		campaign.value = persisted;
		await flushPromises();

		expect(value(wrapper, '#campaignName')).toBe('Autumn digest');
		expect(value(wrapper, '[data-testid="audience-picker"]')).toBe('topic:topic_1');
		// Untouched here, so it comes from the campaign.
		expect(value(wrapper, '#replyTo')).toBe('replies@example.com');
	});

	it('does not refill a field after the user edits it', async () => {
		campaign.value = persisted;
		const wrapper = mountStep();
		await flushPromises();

		await wrapper.find('#campaignName').setValue('');
		campaign.value = { ...persisted, name: 'Renamed elsewhere' };
		await flushPromises();

		expect(value(wrapper, '#campaignName')).toBe('');
	});
});
