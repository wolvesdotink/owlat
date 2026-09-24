// @vitest-environment happy-dom
/**
 * A workspace with no campaign senders must not dead-end the wizard (#785).
 *
 * The admin (who is the person the old copy told everyone to ask) gets the
 * add-a-sender form in place, and a sender added there is selected straight
 * away. A member is told who can add one, by name.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, ref, type Ref } from 'vue';
import { getFunctionName, type FunctionReference } from 'convex/server';
import UiInput from '@owlat/ui/components/ui/Input.vue';

import SetupSenderPicker from '../SetupSenderPicker.vue';
import SetupAddSenderInline from '../SetupAddSenderInline.vue';
import SenderAuthChip from '../../SenderAuthChip.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { installNuxtStubs, queryResult } from '~/__tests__/a11y';

interface PickerData {
	senders: Array<{
		_id: string;
		email: string;
		displayName?: string;
		isDefault: boolean;
		domainVerified: boolean;
		alignment: 'aligned';
		alignmentReason: string | null;
	}>;
	isCustomAllowed: boolean;
	canManage: boolean;
}

let pickerData: Ref<PickerData>;
let pickerError: Ref<Error | null>;
let refetchPicker: ReturnType<typeof vi.fn>;
let domainStatus: Ref<unknown>;
let members: Ref<unknown[]>;
let fetchMembers: ReturnType<typeof vi.fn>;
let createSender: ReturnType<typeof vi.fn>;

const SENDER = {
	_id: 'sender_1',
	email: 'news@example.com',
	displayName: 'Example news',
	isDefault: true,
	domainVerified: true,
	alignment: 'aligned' as const,
	alignmentReason: null,
};

beforeEach(() => {
	pickerData = ref({ senders: [], isCustomAllowed: false, canManage: true });
	pickerError = ref(null);
	refetchPicker = vi.fn();
	domainStatus = ref(undefined);
	members = ref([]);
	fetchMembers = vi.fn(async () => {});
	createSender = vi.fn(async () => ({ ok: true, result: 'sender_1' }));
	installNuxtStubs({
		...i18nStubs,
		useOrganizationQuery: (reference: FunctionReference<'query'>) => {
			const name = getFunctionName(reference);
			if (name === 'campaigns/senders:listForPicker') {
				return {
					...queryResult(undefined),
					data: pickerData,
					error: pickerError,
					refetch: refetchPicker,
				};
			}
			if (name === 'domains/domains:getEmailDomainVerificationStatus') {
				return { ...queryResult(undefined), data: domainStatus };
			}
			return queryResult(undefined);
		},
		useOrganization: () => ({ members, fetchMembers }),
		useBackendOperation: () => ({ run: createSender, isLoading: ref(false), error: ref(null) }),
	});
});

function mountPicker(): VueWrapper {
	return mount(SetupSenderPicker, {
		props: {
			campaignId: null,
			campaignDetails: null,
			fromName: '',
			fromEmail: '',
		},
		global: {
			plugins: [createTestI18n()],
			components: {
				CampaignsStepsSetupAddSenderInline: SetupAddSenderInline,
				CampaignsSenderAuthChip: SenderAuthChip,
				UiInput,
			},
			stubs: { UiErrorAlert: true, UiSelect: true },
		},
	}) as VueWrapper;
}

describe('SetupSenderPicker with no senders', () => {
	it('gives an admin the add-a-sender form instead of "ask your admin"', () => {
		const wrapper = mountPicker();
		expect(wrapper.find('[data-testid="add-sender-inline"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('Add the address this campaign should come from.');
		expect(wrapper.text()).not.toContain('Ask');
	});

	it('selects a sender added inline and fills the from fields', async () => {
		const wrapper = mountPicker();
		wrapper.findComponent(SetupAddSenderInline).vm.$emit('added', 'sender_1');
		pickerData.value = { ...pickerData.value, senders: [SENDER] };
		await nextTick();
		await nextTick();
		expect(wrapper.emitted('update:fromEmail')?.at(-1)).toEqual(['news@example.com']);
		expect(wrapper.emitted('update:fromName')?.at(-1)).toEqual(['Example news']);
		expect(wrapper.find('[data-testid="add-sender-inline"]').exists()).toBe(false);
	});

	it('names the admins for a member, owners first', async () => {
		pickerData.value = { ...pickerData.value, canManage: false };
		members.value = [
			{ role: 'editor', user: { name: 'Eve Editor', email: 'eve@example.com' } },
			{ role: 'admin', user: { name: 'Ben Ito', email: 'ben@example.com' } },
			{ role: 'owner', user: { name: 'Anna Weber', email: 'anna@example.com' } },
		];
		const wrapper = mountPicker();
		await nextTick();
		expect(fetchMembers).toHaveBeenCalled();
		expect(wrapper.find('[data-testid="sender-ask-admin"]').text()).toBe(
			'Ask Anna Weber or Ben Ito to add one. Only admins can add senders.'
		);
		expect(wrapper.find('[data-testid="add-sender-inline"]').exists()).toBe(false);
	});

	it('falls back to generic copy while the member list is unknown', () => {
		pickerData.value = { ...pickerData.value, canManage: false };
		const wrapper = mountPicker();
		expect(wrapper.find('[data-testid="sender-ask-admin"]').text()).toBe(
			'Ask an admin of this workspace to add one. Only admins can add senders.'
		);
	});
});

describe('SetupSenderPicker when the sender list fails to load (#818)', () => {
	it('offers a Try again control that refetches the list', async () => {
		pickerError.value = new Error('Function execution timed out');
		const wrapper = mountPicker();

		const alert = wrapper.find('[data-testid="sender-picker-load-failed"]');
		expect(alert.exists()).toBe(true);
		expect(alert.attributes('action-label')).toBe('Try again');

		wrapper.findComponent({ name: 'UiErrorAlert' }).vm.$emit('action');
		expect(refetchPicker).toHaveBeenCalledTimes(1);
	});
});

describe('SetupAddSenderInline', () => {
	function mountInline(): VueWrapper {
		return mount(SetupAddSenderInline, {
			global: {
				plugins: [createTestI18n()],
				components: { UiInput },
				stubs: { UiErrorAlert: true },
			},
		}) as VueWrapper;
	}

	it('keeps the add button disabled until the domain is verified', async () => {
		const wrapper = mountInline();
		await wrapper.find('input[type="email"]').setValue('news@example.com');
		domainStatus.value = { domain: 'example.com', exists: true, verified: false, stale: false };
		await nextTick();
		const button = wrapper.find('[data-testid="add-sender-submit"]');
		expect(button.attributes('disabled')).toBeDefined();
		expect(wrapper.find('[data-testid="add-sender-verification"]').text()).toContain(
			"isn't verified yet"
		);
	});

	it('adds the sender and reports its id', async () => {
		const wrapper = mountInline();
		const [emailInput, nameInput] = wrapper.findAll('input');
		await emailInput!.setValue('news@example.com');
		await nameInput!.setValue('Example news');
		domainStatus.value = { domain: 'example.com', exists: true, verified: true, stale: false };
		await nextTick();
		await wrapper.find('[data-testid="add-sender-submit"]').trigger('click');
		await nextTick();
		expect(createSender).toHaveBeenCalledWith({
			email: 'news@example.com',
			displayName: 'Example news',
		});
		expect(wrapper.emitted('added')).toEqual([['sender_1']]);
	});
});
