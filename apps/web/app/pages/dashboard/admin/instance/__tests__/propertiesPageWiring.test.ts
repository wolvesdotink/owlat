/**
 * The contact properties admin page, through its pieces: each row and its
 * menu, the create, edit and delete modals. The pieces only render and emit;
 * the page validates and writes, so these cases assert on what reaches the
 * backend.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref } from 'vue';
import { flushPromises } from '@vue/test-utils';
import PropertiesPage from '../properties.vue';
import { installNuxtStubs, mountDashboardPage, queryResult } from '~/__tests__/a11y';
import { i18nStubs } from '~/__tests__/i18n';
import { useClickOutsideSelector } from '~/composables/useClickOutside';
import { useFormModal } from '~/composables/useFormModal';

const PROPERTIES = [
	{ _id: 'prop_company', key: 'company', label: 'Company', type: 'string' },
	{
		_id: 'prop_legacy',
		key: 'legacy_id',
		label: 'Legacy ID',
		type: 'number',
		deletionRequestedAt: 1,
		deletion: { status: 'failed', valuesDeleted: 40 },
	},
];

const ops: Record<string, ReturnType<typeof vi.fn>> = {};
const countByProperty = vi.fn(async () => 412);

const ModalStub = defineComponent({
	props: { open: { type: Boolean, default: false }, title: { type: String, default: '' } },
	emits: ['update:open'],
	template:
		'<section v-if="open" role="dialog" :aria-label="title"><slot /><footer><slot name="footer" /></footer></section>',
});

const InputStub = defineComponent({
	props: ['modelValue', 'label', 'error'],
	emits: ['update:modelValue'],
	template:
		'<label>{{ label }}<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" /><em v-if="error">{{ error }}</em></label>',
});

beforeEach(() => {
	for (const key of Object.keys(ops)) delete ops[key];
	countByProperty.mockClear();
	installNuxtStubs({
		...i18nStubs,
		useFormModal,
		useClickOutsideSelector,
		useOrganizationQuery: () => queryResult(PROPERTIES),
		useConvex: () => ({ query: countByProperty }),
		useBackendOperation: (_fn: unknown, options: { label: () => string }) => {
			const run = vi.fn(async () => ({ ok: true, result: 'pending' }));
			ops[options.label()] = run;
			return { run, isLoading: ref(false) };
		},
	});
});

function mountPage() {
	return mountDashboardPage(PropertiesPage, {
		stubs: {
			UiPageHeader: { template: '<header><slot name="actions" /></header>' },
			UiButton: { template: '<button v-bind="$attrs"><slot /></button>', inheritAttrs: false },
			UiQueryBoundary: { template: '<div><slot /></div>' },
			UiModal: ModalStub,
			UiInput: InputStub,
			I18nT: { template: '<p><slot name="token" /><slot name="name" /></p>' },
		},
	});
}

const dialog = (wrapper: ReturnType<typeof mountPage>) => wrapper.get('[role="dialog"]');
const button = (scope: { findAll: (s: string) => Array<{ text(): string }> }, label: string) =>
	scope.findAll('button').find((candidate) => candidate.text().trim() === label) as
		| ReturnType<ReturnType<typeof mountPage>['get']>
		| undefined;

describe('contact properties admin page', () => {
	it('lists a live property with its type and a stopped deletion with Retry', async () => {
		const wrapper = mountPage();
		const rows = wrapper.findAll('.divide-y > div');
		expect(rows).toHaveLength(2);
		expect(rows[0]!.text()).toContain('Company');
		expect(rows[0]!.text()).toContain('Text');
		expect(rows[0]!.text()).toContain('company');
		expect(rows[1]!.get('[data-testid="property-pending-deletion"]').text()).toContain(
			'Deletion stopped after repeated errors'
		);

		await button(rows[1]!, 'Retry deletion')!.trigger('click');
		await flushPromises();
		expect(ops['Delete property']).toHaveBeenCalledWith({ propertyId: 'prop_legacy' });
		wrapper.unmount();
	});

	it('edits the label from the row menu', async () => {
		const wrapper = mountPage();
		await wrapper.get('[data-property-dropdown] button').trigger('click');
		await button(wrapper, 'Edit')!.trigger('click');
		expect(dialog(wrapper).text()).toContain('company');
		await dialog(wrapper).get('input').setValue('Company name');
		await button(dialog(wrapper), 'Save changes')!.trigger('click');
		await flushPromises();
		expect(ops['Update property']).toHaveBeenCalledWith({
			propertyId: 'prop_company',
			label: 'Company name',
		});
		expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
		wrapper.unmount();
	});

	it('derives the key from the label and creates the chosen type', async () => {
		const wrapper = mountPage();
		await button(wrapper, 'New property')!.trigger('click');
		const [label, key] = dialog(wrapper).findAll('input');
		await label!.setValue('Favourite colour');
		expect((key!.element as HTMLInputElement).value).toBe('favourite_colour');
		await dialog(wrapper)
			.findAll('button')
			.find((b) => b.text().startsWith('Number'))!
			.trigger('click');
		await button(dialog(wrapper), 'Create property')!.trigger('click');
		await flushPromises();
		expect(ops['Create property']).toHaveBeenCalledWith({
			key: 'favourite_colour',
			label: 'Favourite colour',
			type: 'number',
		});
		wrapper.unmount();
	});

	it('rejects a malformed key without writing', async () => {
		const wrapper = mountPage();
		await button(wrapper, 'New property')!.trigger('click');
		const [label, key] = dialog(wrapper).findAll('input');
		await label!.setValue('Plan');
		await key!.setValue('Bad Key');
		await dialog(wrapper).get('form').trigger('submit');
		expect(dialog(wrapper).text()).toContain('lowercase');
		expect(ops['Create property']).not.toHaveBeenCalled();
		wrapper.unmount();
	});

	it('warns how many contacts hold a value before deleting', async () => {
		const wrapper = mountPage();
		await wrapper.get('[data-property-dropdown] button').trigger('click');
		await button(wrapper, 'Delete')!.trigger('click');
		await flushPromises();
		expect(countByProperty).toHaveBeenCalledWith(expect.anything(), {
			propertyId: 'prop_company',
		});
		expect(dialog(wrapper).text()).toContain('412 contacts have values for this property');
		await button(dialog(wrapper), 'Delete property')!.trigger('click');
		await flushPromises();
		expect(ops['Delete property']).toHaveBeenCalledWith({ propertyId: 'prop_company' });
		expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
		wrapper.unmount();
	});
});
