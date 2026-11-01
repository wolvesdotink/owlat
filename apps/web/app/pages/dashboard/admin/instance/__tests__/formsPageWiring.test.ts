/**
 * The forms admin page, end to end through its pieces: the endpoint card's
 * header and expanded body, and the add and edit modals. Each piece only
 * renders and emits; the page and useFormSettings own the state and the
 * writes, so these cases drive the real composable and assert on what it
 * sends.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref } from 'vue';
import { flushPromises } from '@vue/test-utils';
import FormsPage from '../forms.vue';
import { installNuxtStubs, mountDashboardPage, queryResult } from '~/__tests__/a11y';
import { i18nStubs } from '~/__tests__/i18n';
import { useFormSettings } from '~/composables/useFormSettings';
import { formatDate } from '~/utils/formatters';

const FORMS = [
	{
		_id: 'form_news',
		name: 'Newsletter signup',
		topicId: 'topic_product',
		fields: [{ key: 'email', label: 'Email', type: 'email', required: true }],
		honeypotFieldName: 'website',
		isActive: true,
		totalSubmissions: 12,
		successfulSubmissions: 9,
		createdAt: Date.parse('2026-09-01T10:00:00Z'),
	},
];

const ops: Record<string, ReturnType<typeof vi.fn>> = {};
const copy = vi.fn(async () => true);

const ModalStub = defineComponent({
	props: { open: { type: Boolean, default: false }, title: { type: String, default: '' } },
	emits: ['update:open'],
	template:
		'<section v-if="open" role="dialog" :aria-label="title"><slot /><footer><slot name="footer" /></footer></section>',
});

beforeEach(() => {
	for (const key of Object.keys(ops)) delete ops[key];
	copy.mockClear();
	installNuxtStubs({
		...i18nStubs,
		useFormSettings,
		formatDate,
		useOrganizationQuery: () => queryResult(FORMS),
		useTopicsList: () => ({
			results: ref([{ _id: 'topic_product', name: 'Product updates' }]),
			isLoading: ref(false),
			status: ref('Exhausted'),
		}),
		useBackendOperation: (_fn: unknown, options: { label: () => string }) => {
			const run = vi.fn(async () => ({ ok: true, result: undefined }));
			ops[options.label()] = run;
			return { run, isLoading: ref(false) };
		},
		useCopyToClipboard: () => ({ copy, copiedKey: ref(null) }),
		useUnsavedChanges: () => ({
			showDialog: ref(false),
			isSavingBeforeLeave: ref(false),
			confirmDiscard: vi.fn(),
			confirmSave: vi.fn(),
			cancelNavigation: vi.fn(),
			setHasChanges: vi.fn(),
		}),
	});
});

function mountPage() {
	return mountDashboardPage(FormsPage, {
		stubs: {
			UiPageHeader: { template: '<header><slot name="actions" /></header>' },
			UiButton: { template: '<button v-bind="$attrs"><slot /></button>', inheritAttrs: false },
			UiTooltip: { template: '<span><slot /></span>' },
			UiSwitch: {
				props: ['modelValue'],
				emits: ['update:modelValue'],
				template:
					'<button role="switch" :aria-checked="modelValue" @click="$emit(\'update:modelValue\', !modelValue)" />',
			},
			UiModal: ModalStub,
			UiConfirmationDialog: {
				props: ['open', 'description'],
				template: '<div v-if="open" role="alertdialog">{{ description }}</div>',
			},
			UiUnsavedChangesDialog: true,
			UiQueryBoundary: true,
			DashboardListSkeleton: true,
			FormsFieldsEditor: true,
			FormsSubmissionsPanel: true,
		},
	});
}

const button = (wrapper: ReturnType<typeof mountPage>, label: string) =>
	wrapper.findAll('button').find((candidate) => candidate.text().trim() === label);

describe('forms admin page', () => {
	it('shows the endpoint row and expands it into its stats, URL and embed code', async () => {
		const wrapper = mountPage();
		expect(wrapper.text()).toContain('Newsletter signup');
		expect(wrapper.text()).toContain('Product updates');
		expect(wrapper.text()).not.toContain('Submission statistics');

		await wrapper.get('.cursor-pointer').trigger('click');
		expect(wrapper.text()).toContain('Submission statistics');
		const url = 'https://example.convex.site/forms/form_news';
		expect(wrapper.get('code').text()).toBe(url);
		expect(wrapper.get('pre').text()).toContain(`<form action="${url}" method="POST">`);

		await wrapper.get('button[aria-label="Copy URL"]').trigger('click');
		expect(copy).toHaveBeenCalledWith(url, 'url-form_news');
		await button(wrapper, 'Copy code')!.trigger('click');
		expect(copy).toHaveBeenLastCalledWith(
			expect.stringContaining('name="website"'),
			'embed-form_news'
		);
		wrapper.unmount();
	});

	it('toggles the endpoint from its switch without expanding it', async () => {
		const wrapper = mountPage();
		await wrapper.get('[role="switch"]').trigger('click');
		await flushPromises();
		expect(ops['Update form endpoint']).toHaveBeenCalledWith({
			formEndpointId: 'form_news',
			isActive: false,
		});
		expect(wrapper.text()).not.toContain('Submission statistics');
		wrapper.unmount();
	});

	it('writes the add modal into the draft, and Cancel resets it', async () => {
		const wrapper = mountPage();
		await button(wrapper, 'New form')!.trigger('click');
		await wrapper.get('#form-name').setValue('Event signup');
		await wrapper.get('#form-redirect').setValue('https://owlat.example/thanks');
		await wrapper.get('#add-form').trigger('submit');
		await flushPromises();
		expect(ops['Create form endpoint']).toHaveBeenCalledWith(
			expect.objectContaining({
				name: 'Event signup',
				redirectUrl: 'https://owlat.example/thanks',
			})
		);
		expect(wrapper.find('#form-name').exists()).toBe(false);

		await button(wrapper, 'New form')!.trigger('click');
		await wrapper.get('#form-name').setValue('Draft');
		await button(wrapper, 'Cancel')!.trigger('click');
		expect(wrapper.find('#form-name').exists()).toBe(false);
		await button(wrapper, 'New form')!.trigger('click');
		expect((wrapper.get('#form-name').element as HTMLInputElement).value).toBe('');
		wrapper.unmount();
	});

	it('opens the edit modal on the stored row and saves the edited name', async () => {
		const wrapper = mountPage();
		await wrapper.get('button[aria-label="Edit form"]').trigger('click');
		const name = wrapper.get<HTMLInputElement>('#edit-form-name');
		expect(name.element.value).toBe('Newsletter signup');
		await name.setValue('Newsletter');
		await wrapper.get('#edit-form').trigger('submit');
		await flushPromises();
		expect(ops['Update form endpoint']).toHaveBeenCalledWith(
			expect.objectContaining({ formEndpointId: 'form_news', name: 'Newsletter' })
		);
		expect(wrapper.find('#edit-form-name').exists()).toBe(false);
		wrapper.unmount();
	});

	it('asks before deleting, naming the form', async () => {
		const wrapper = mountPage();
		expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
		await wrapper.get('button[aria-label="Delete form"]').trigger('click');
		expect(wrapper.get('[role="alertdialog"]').text()).toContain('Newsletter signup');
		expect(wrapper.text()).not.toContain('Submission statistics');
		wrapper.unmount();
	});
});
