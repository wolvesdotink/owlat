/**
 * The instance's transactional sender dialog: it starts from what is saved,
 * offers the stream layout's transactional subdomain with the reason, refuses
 * an unverified domain before saving, and goes back to the default sender.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, ref, type Ref } from 'vue';
import UiInput from '@owlat/ui/components/ui/Input.vue';
import SenderDialog from '../SenderDialog.vue';
import SenderAddressField from '../SenderAddressField.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import { installNuxtStubs, queryResult } from '~/__tests__/a11y';

let state: Ref<Record<string, unknown> | undefined>;
let save: ReturnType<typeof vi.fn>;

const BASE = {
	resolved: {
		address: 'hello@example.com',
		name: 'Example',
		source: 'default',
		isDomainVerified: true,
	},
	inherited: { address: 'hello@example.com', name: 'Example', source: 'default' },
	transactional: null,
	template: null,
	defaultSender: { address: 'hello@example.com', name: 'Example' },
	sendingDomains: [
		{ domain: 'example.com', isVerified: true },
		{ domain: 'mail.example.com', isVerified: true },
		{ domain: 'news.example.com', isVerified: false },
	],
	suggestedDomain: 'mail.example.com',
	canManageInstance: true,
	canManageTemplate: true,
};

beforeEach(() => {
	state = ref({ ...BASE });
	save = vi.fn(async () => ({ ok: true, result: null }));
	installNuxtStubs({
		...i18nStubs,
		useOrganizationQuery: () => ({
			...queryResult(undefined),
			data: state,
			isLoading: ref(false),
		}),
		useBackendOperation: () => ({ run: save, isLoading: ref(false), error: ref(null) }),
		useToast: () => ({ showToast: vi.fn() }),
	});
});

const ModalStub = {
	props: ['open', 'title'],
	template:
		'<div v-if="open"><h2>{{ title }}</h2><slot /><footer><slot name="footer" /></footer></div>',
};
const FooterStub = {
	props: ['isDisabled', 'confirmText'],
	emits: ['confirm', 'cancel'],
	template:
		'<button data-testid="save" :disabled="isDisabled" @click="$emit(\'confirm\')">{{ confirmText }}</button>',
};
const RadioStub = {
	props: ['modelValue', 'value', 'label', 'description'],
	emits: ['update:modelValue'],
	template:
		'<label><input type="radio" :value="value" :checked="modelValue === value" @change="$emit(\'update:modelValue\', value)" />{{ label }} {{ description }}</label>',
};

async function mountDialog(): Promise<VueWrapper> {
	const wrapper = mount(SenderDialog, {
		props: { open: true },
		global: {
			plugins: [createTestI18n()],
			components: { TransactionalSenderAddressField: SenderAddressField, UiInput },
			stubs: {
				UiModal: ModalStub,
				UiModalFooter: FooterStub,
				UiSelectableListItem: RadioStub,
				UiSkeleton: true,
				UiErrorAlert: { props: ['message'], template: '<p role="alert">{{ message }}</p>' },
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
				UiButton: {
					emits: ['click'],
					template: '<button type="button" @click="$emit(\'click\')"><slot /></button>',
				},
			},
		},
	}) as VueWrapper;
	await nextTick();
	return wrapper;
}

describe('SenderDialog', () => {
	it('starts on the default sender and offers the transactional subdomain with its reason', async () => {
		const wrapper = await mountDialog();
		const checked = wrapper.find('input[type="radio"]:checked');
		expect((checked.element as HTMLInputElement).value).toBe('default');
		const suggestion = wrapper.find('[data-testid="transactional-sender-suggestion"]');
		expect(suggestion.text()).toContain('Send from mail.example.com');
		expect(suggestion.text()).toContain('keeps complaints about your newsletters');
		// Nothing changed yet: nothing to save.
		expect(wrapper.find('[data-testid="save"]').attributes('disabled')).toBeDefined();
		expectFullyLocalized(wrapper);
	});

	it('applies the suggestion in one click and saves it', async () => {
		const wrapper = await mountDialog();
		await wrapper.find('[data-testid="transactional-sender-suggestion"] button').trigger('click');
		expect((wrapper.find('[data-testid="sender-domain"]').element as HTMLSelectElement).value).toBe(
			'mail.example.com'
		);
		expect(wrapper.find('[data-testid="sender-preview"]').text()).toContain(
			'Example <hello@mail.example.com>'
		);
		await wrapper.find('[data-testid="save"]').trigger('click');
		await flushPromises();
		expect(save).toHaveBeenCalledWith({
			sender: { email: 'hello@mail.example.com', name: 'Example' },
		});
	});

	it('will not save an address on an unverified domain, and says where to fix it', async () => {
		const wrapper = await mountDialog();
		await wrapper.find('input[value="own"]').trigger('change');
		await wrapper.find('[data-testid="sender-domain"]').setValue('news.example.com');
		expect(wrapper.find('[data-testid="sender-verdict"]').text()).toContain(
			"news.example.com isn't verified yet"
		);
		expect(wrapper.find('[data-testid="sender-domains-link"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="save"]').attributes('disabled')).toBeDefined();
	});

	it('goes back to the default sender', async () => {
		state.value = {
			...BASE,
			transactional: { email: 'account@mail.example.com', name: null },
		};
		const wrapper = await mountDialog();
		expect((wrapper.find('input[type="radio"]:checked').element as HTMLInputElement).value).toBe(
			'own'
		);
		await wrapper.find('input[value="default"]').trigger('change');
		await wrapper.find('[data-testid="save"]').trigger('click');
		await flushPromises();
		expect(save).toHaveBeenCalledWith({ sender: null });
	});
});
