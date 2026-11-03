/**
 * The API keys page, end to end through its table, its create and created-key
 * modals and its revoke and delete confirmations. The page owns the reads and
 * the writes; these cases assert on what it sends and what it shows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { installNuxtStubs, queryResult } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { formatCompactRelativeTime, formatDate, formatDateTime } from '~/utils/formatters';
import ApiKeysPage from '../index.vue';

const NOW = Date.parse('2026-08-21T09:12:00Z');
const KEYS = [
	{
		_id: 'key_live',
		name: 'Checkout service',
		keyPrefix: 'lm_live_Qx7r',
		isActive: true,
		lastUsedAt: NOW,
		createdAt: NOW,
	},
	{
		_id: 'key_old',
		name: 'Old staging key',
		keyPrefix: 'lm_live_Df8g',
		isActive: false,
		createdAt: NOW,
	},
];

const keys = ref<typeof KEYS | undefined>(KEYS);
const ops: Record<string, ReturnType<typeof vi.fn>> = {};
const showToast = vi.fn();
const copy = vi.fn(async () => true);

const ModalStub = defineComponent({
	props: { open: { type: Boolean, default: false }, title: { type: String, default: '' } },
	emits: ['update:open'],
	template:
		'<section v-if="open" role="dialog" :aria-label="title"><slot /><footer><slot name="footer" /></footer></section>',
});
const ConfirmStub = defineComponent({
	props: ['open', 'title', 'description', 'confirmText'],
	emits: ['confirm', 'update:open'],
	template:
		'<div v-if="open" role="alertdialog" :aria-label="title"><p>{{ description }}</p><button @click="$emit(\'confirm\')">{{ confirmText }}</button></div>',
});

beforeEach(() => {
	keys.value = KEYS;
	for (const key of Object.keys(ops)) delete ops[key];
	showToast.mockClear();
	copy.mockClear();
	installNuxtStubs({
		...i18nStubs,
		useToast: () => ({ showToast }),
		useOrganizationQuery: () => ({ ...queryResult(undefined), data: keys }),
		useBackendOperation: (_fn: unknown, options: { label: () => string }) => {
			const label = options.label();
			const run = vi.fn(async () =>
				label === 'Create API key'
					? {
							ok: true,
							result: {
								name: 'Billing relay',
								apiKey: 'lm_live_secret_value',
								keyPrefix: 'lm_live_Nw4p',
							},
						}
					: { ok: true, result: undefined }
			);
			ops[label] = run;
			return { run, isLoading: ref(false) };
		},
		useCopyToClipboard: () => {
			const copiedKey = ref<string | null>(null);
			return {
				copy: async (text: string, key: string) => {
					copiedKey.value = key;
					return copy(text, key);
				},
				isCopied: (key: string) => copiedKey.value === key,
				reset: () => {
					copiedKey.value = null;
				},
			};
		},
	});
});

function mountPage() {
	return mount(ApiKeysPage, {
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			mocks: { formatCompactRelativeTime, formatDate, formatDateTime },
			stubs: {
				UiIconBox: true,
				UiPageHeader: {
					template:
						'<header><slot /><div data-testid="page-header-actions"><slot name="actions" /></div></header>',
				},
				UiButton: { template: '<button v-bind="$attrs"><slot /></button>', inheritAttrs: false },
				UiTooltip: { template: '<span><slot /></span>' },
				UiQueryBoundary: true,
				DashboardListSkeleton: true,
				UiModal: ModalStub,
				UiConfirmationDialog: ConfirmStub,
			},
		},
	});
}

const button = (wrapper: ReturnType<typeof mountPage>, label: string) =>
	wrapper.findAll('button').filter((b) => b.text().trim() === label);

describe('API keys page', () => {
	it('lists the keys and renames one inline', async () => {
		const wrapper = mountPage();
		const text = wrapper.text();
		expect(text).toContain('1 active key');
		expect(text).toContain('lm_live_Qx7r...');
		expect(text).toContain('Revoked');
		expect(text).toContain('Never used');
		expect(text).toContain('X-RateLimit-Remaining');
		// A revoked key has nothing to revoke.
		expect(wrapper.findAll('button[aria-label="Revoke key"]')).toHaveLength(1);

		await wrapper.get('button[aria-label="Rename key"]').trigger('click');
		const input = wrapper.get('input[aria-label="API key name"]');
		expect((input.element as HTMLInputElement).value).toBe('Checkout service');
		await input.setValue('  Checkout (prod)  ');
		await input.trigger('keyup.enter');
		await flushPromises();
		expect(ops['Rename API key']).toHaveBeenCalledWith({
			keyId: 'key_live',
			name: 'Checkout (prod)',
		});
		expect(wrapper.find('input[aria-label="API key name"]').exists()).toBe(false);

		await wrapper.findAll('button[aria-label="Rename key"]')[1]!.trigger('click');
		await wrapper.get('button[aria-label="Cancel"]').trigger('click');
		expect(wrapper.find('input[aria-label="API key name"]').exists()).toBe(false);
		wrapper.unmount();
	});

	it('validates, creates a scoped key and shows the secret once', async () => {
		const wrapper = mountPage();
		await wrapper.get('[data-testid="page-header-actions"] button').trigger('click');
		const modal = () => wrapper.get('[role="dialog"][aria-label="Create API key"]');

		await button(wrapper, 'Create key')[0]!.trigger('click');
		expect(modal().text()).toContain('Name is required');
		await modal().get('#key-name').setValue('Billing relay');
		await button(wrapper, 'Create key')[0]!.trigger('click');
		expect(modal().text()).toContain('Select at least one scope');
		expect(ops['Create API key']).not.toHaveBeenCalled();

		const boxes = modal().findAll('input[type="checkbox"]');
		expect(boxes).toHaveLength(5);
		await boxes[2]!.setValue(true);
		await boxes[0]!.setValue(true);
		await modal().get('form').trigger('submit');
		await flushPromises();
		expect(ops['Create API key']).toHaveBeenCalledWith({
			name: 'Billing relay',
			scopes: ['events:write', 'contacts:read'],
		});
		expect(showToast).toHaveBeenLastCalledWith('API key created successfully');
		expect(wrapper.find('[aria-label="Create API key"]').exists()).toBe(false);

		const created = wrapper.get('[role="dialog"]');
		expect(created.text()).toContain('API key created');
		expect(created.text()).toContain('lm_live_secret_value');
		await button(wrapper, 'Copy')[0]!.trigger('click');
		await flushPromises();
		expect(copy).toHaveBeenCalledWith('lm_live_secret_value', 'created-api-key');
		expect(created.text()).toContain('Copied!');
		await button(wrapper, 'Done')[0]!.trigger('click');
		expect(wrapper.find('[role="dialog"]').exists()).toBe(false);

		// Opening the form again starts from a clean draft.
		await wrapper.get('[data-testid="page-header-actions"] button').trigger('click');
		expect((modal().get('#key-name').element as HTMLInputElement).value).toBe('');
		expect(modal().findAll('input[type="checkbox"]:checked')).toHaveLength(0);
		wrapper.unmount();
	});

	it('revokes and deletes a key after confirming', async () => {
		const wrapper = mountPage();
		await wrapper.get('button[aria-label="Revoke key"]').trigger('click');
		expect(wrapper.get('[role="alertdialog"]').text()).toContain('Revoking "Checkout service"');
		await button(wrapper, 'Revoke key')[0]!.trigger('click');
		await flushPromises();
		expect(ops['Revoke API key']).toHaveBeenCalledWith({ keyId: 'key_live' });
		expect(showToast).toHaveBeenLastCalledWith('API key revoked successfully');
		expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);

		await wrapper.findAll('button[aria-label="Delete key"]')[1]!.trigger('click');
		expect(wrapper.get('[role="alertdialog"]').text()).toContain(
			'Permanently delete "Old staging key"?'
		);
		await button(wrapper, 'Delete key')[0]!.trigger('click');
		await flushPromises();
		expect(ops['Delete API key']).toHaveBeenCalledWith({ keyId: 'key_old' });
		expect(showToast).toHaveBeenLastCalledWith('API key deleted permanently');
		wrapper.unmount();
	});

	it('offers the create form from the empty state', async () => {
		keys.value = [];
		const wrapper = mountPage();
		expect(wrapper.text()).toContain('No API keys yet');
		const createButtons = button(wrapper, 'Create API key');
		await createButtons.at(-1)!.trigger('click');
		expect(wrapper.find('[role="dialog"][aria-label="Create API key"]').exists()).toBe(true);
		wrapper.unmount();
	});
});
