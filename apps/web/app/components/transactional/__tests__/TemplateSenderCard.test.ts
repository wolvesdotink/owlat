/**
 * A transactional email's sender in the editor: the inherited sender is shown
 * until overridden, an override needs a verified domain, and "Use the
 * transactional sender" goes back. Loading and error are their own states.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ref, type Ref } from 'vue';
import UiInput from '@owlat/ui/components/ui/Input.vue';
import TemplateSenderCard from '../TemplateSenderCard.vue';
import SenderAddressField from '../SenderAddressField.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import { installNuxtStubs, queryResult } from '~/__tests__/a11y';

type SenderState = Record<string, unknown>;

let state: Ref<SenderState | undefined>;
let loadError: Ref<Error | null>;
let save: ReturnType<typeof vi.fn>;

const BASE: SenderState = {
	resolved: {
		address: 'account@mail.example.com',
		name: 'Example',
		source: 'transactional',
		isDomainVerified: true,
	},
	inherited: { address: 'account@mail.example.com', name: 'Example', source: 'transactional' },
	transactional: { email: 'account@mail.example.com', name: 'Example' },
	template: null,
	defaultSender: { address: 'hello@example.com', name: 'Example' },
	sendingDomains: [
		{ domain: 'mail.example.com', isVerified: true },
		{ domain: 'news.example.com', isVerified: false },
	],
	suggestedDomain: 'mail.example.com',
	canManageInstance: true,
	canManageTemplate: true,
};

beforeEach(() => {
	state = ref({ ...BASE });
	loadError = ref(null);
	save = vi.fn(async () => ({ ok: true, result: null }));
	installNuxtStubs({
		...i18nStubs,
		useOrganizationQuery: () => ({
			...queryResult(undefined),
			data: state,
			error: loadError,
			isLoading: ref(false),
		}),
		useBackendOperation: () => ({ run: save, isLoading: ref(false), error: ref(null) }),
		useToast: () => ({ showToast: vi.fn() }),
	});
});

function mountCard(): VueWrapper {
	return mount(TemplateSenderCard, {
		props: { emailId: 'tpl_1' as never },
		global: {
			plugins: [createTestI18n()],
			components: { TransactionalSenderAddressField: SenderAddressField, UiInput },
			stubs: {
				UiErrorAlert: { props: ['message'], template: '<p role="alert">{{ message }}</p>' },
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
				UiButton: {
					props: ['disabled', 'type'],
					emits: ['click'],
					template:
						'<button :type="type ?? \'button\'" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
				},
			},
		},
	}) as VueWrapper;
}

describe('TemplateSenderCard', () => {
	it('shows the sender the email inherits until it is overridden', () => {
		const wrapper = mountCard();
		expect(wrapper.find('[data-testid="template-sender-inherited"]').text()).toBe(
			'Uses the transactional sender (Example <account@mail.example.com>).'
		);
		expect(wrapper.find('[data-testid="template-sender-edit"]').text()).toBe(
			'Use a different sender'
		);
		expectFullyLocalized(wrapper);
	});

	it('saves an override only on a verified domain', async () => {
		const wrapper = mountCard();
		await wrapper.find('[data-testid="template-sender-edit"]').trigger('click');
		await wrapper.find('[data-testid="sender-local-part"]').setValue('receipts');
		await wrapper.find('[data-testid="sender-domain"]').setValue('news.example.com');

		const submit = wrapper.find('form button[type="submit"]');
		expect(submit.attributes('disabled')).toBeDefined();
		expect(wrapper.find('[data-testid="sender-verdict"]').text()).toContain(
			"news.example.com isn't verified yet"
		);
		expect(wrapper.find('[data-testid="sender-domains-link"]').attributes('href')).toBe(
			'/dashboard/admin/delivery/domains'
		);

		await wrapper.find('[data-testid="sender-domain"]').setValue('mail.example.com');
		expect(submit.attributes('disabled')).toBeUndefined();
		await wrapper.find('form').trigger('submit');
		await flushPromises();
		expect(save).toHaveBeenCalledWith({
			id: 'tpl_1',
			sender: { email: 'receipts@mail.example.com', name: 'Example' },
		});
	});

	it('goes back to the transactional sender in one action', async () => {
		state.value = {
			...BASE,
			template: { email: 'receipts@mail.example.com', name: 'Billing' },
			resolved: {
				address: 'receipts@mail.example.com',
				name: 'Billing',
				source: 'template',
				isDomainVerified: true,
			},
		};
		const wrapper = mountCard();
		expect(wrapper.find('[data-testid="template-sender-own"]').text()).toContain(
			'Billing <receipts@mail.example.com>'
		);
		const restore = wrapper.find('[data-testid="template-sender-restore"]');
		expect(restore.text()).toBe('Use the transactional sender');
		await restore.trigger('click');
		await flushPromises();
		expect(save).toHaveBeenCalledWith({ id: 'tpl_1', sender: null });
	});

	it('is read-only for someone who cannot manage templates', () => {
		state.value = { ...BASE, canManageTemplate: false };
		const wrapper = mountCard();
		expect(wrapper.find('[data-testid="template-sender-edit"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="template-sender-inherited"]').exists()).toBe(true);
	});

	it('keeps loading and a failed load apart from a sender', () => {
		state.value = undefined;
		loadError.value = new Error('offline');
		const wrapper = mountCard();
		expect(wrapper.find('[role="alert"]').text()).toBe("Couldn't load this email's sender.");
		expect(wrapper.find('[data-testid="template-sender-inherited"]').exists()).toBe(false);
	});
});
