// @vitest-environment happy-dom
/**
 * Editable lists keyed by row, not by index.
 *
 * With `:key="index"`, removing a row hands the removed row's DOM to the row
 * that slides up into its place: the focused input, its caret and any text an
 * IME is still composing jump to a different row's value. Each list here keeps
 * a row's own element for as long as the row exists.
 */
import { describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { computed, reactive, ref, watch } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import FieldsEditor from '../forms/FieldsEditor.vue';
import EhloOverridesCard from '../delivery/EhloOverridesCard.vue';
import SendTestEmailModal from '../SendTestEmailModal.vue';

vi.mock('@owlat/api', () => ({
	api: {
		workspaces: { settings: { get: 'workspaces.settings.get' } },
		domains: { domains: { listByOrganization: 'domains.domains.listByOrganization' } },
		campaigns: { testSend: { sendTestEmailFromTemplate: 'campaigns.testSend.send' } },
	},
}));

Object.assign(globalThis, {
	...i18nStubs,
	computed,
	ref,
	watch,
	useToast: () => ({ showToast: vi.fn() }),
	useConvex: () => null,
	useOrganizationQuery: () => ({ data: ref(undefined) }),
});

const stubs = {
	Icon: { template: '<i />' },
	I18nT: { template: '<span />' },
	UiIconBox: { template: '<span />' },
	UiCard: { template: '<section><slot name="header" /><slot /></section>' },
	UiModal: { template: '<div><slot /></div>' },
	UiSpinner: true,
	DeliveryEnvSetupSteps: true,
	UiButton: {
		emits: ['click'],
		template: '<button type="button" @click="$emit(\'click\')"><slot /></button>',
	},
	UiInput: {
		props: ['modelValue'],
		emits: ['update:modelValue'],
		template:
			'<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
	},
};

const global = { plugins: [createTestI18n()], stubs };

async function type(wrapper: VueWrapper, index: number, value: string) {
	const inputs = wrapper.findAll('input');
	await inputs[index]!.setValue(value);
}

describe('editable lists keep a row its own element', () => {
	it('EHLO overrides: removing the first row leaves the second row its input', async () => {
		const w = mount(EhloOverridesCard, { global });
		await w.find('[data-testid="ehlo-override-add"]').trigger('click');
		// Two inputs per row: IP, hostname.
		await type(w, 0, '203.0.113.1');
		await type(w, 2, '203.0.113.2');
		const secondRowIp = w.findAll('input')[2]!.element;

		const rows = w.findAll('[data-testid="ehlo-override-row"]');
		await rows[0]!.find('button').trigger('click');

		const inputs = w.findAll('input');
		expect(inputs).toHaveLength(2);
		expect(inputs[0]!.element).toBe(secondRowIp);
		expect((inputs[0]!.element as HTMLInputElement).value).toBe('203.0.113.2');
	});

	it('form fields: moving a field moves its inputs with it', async () => {
		const fields = reactive([
			{ key: 'email', label: 'Email', type: 'email' as const, required: true },
			{ key: 'name', label: 'Name', type: 'text' as const, required: false },
		]);
		const editor = {
			addField: () => {},
			removeField: (index: number) => void fields.splice(index, 1),
			moveField: (index: number, direction: -1 | 1) => {
				const [moved] = fields.splice(index, 1);
				fields.splice(index + direction, 0, moved!);
			},
		};
		const w = mount(FieldsEditor, { props: { fields, editor, idPrefix: 'f' }, global });
		const keyInputs = () => w.findAll('input[type="text"]').filter((_, i) => i % 2 === 0);
		const nameKeyInput = keyInputs()[1]!.element;

		editor.moveField(1, -1);
		await w.vm.$nextTick();

		expect(keyInputs()[0]!.element).toBe(nameKeyInput);
		expect((keyInputs()[0]!.element as HTMLInputElement).value).toBe('name');
	});

	it('test email recipients: removing the first address keeps the second its input', async () => {
		const w = mount(SendTestEmailModal, {
			props: { open: true, html: '<p>x</p>', subject: 'S' },
			global,
		});
		const addButton = () => w.findAll('button').find((b) => b.text().includes('Add another'));
		await addButton()!.trigger('click');
		const emails = () => w.findAll('input[type="email"]');
		await emails()[0]!.setValue('one@example.com');
		await emails()[1]!.setValue('two@example.com');
		const second = emails()[1]!.element;

		// The row's remove control is the button right after its input.
		const removeFirst = emails()[0]!
			.element.closest('.flex.items-center')!
			.querySelector('button')!;
		removeFirst.click();
		await w.vm.$nextTick();

		expect(emails()).toHaveLength(1);
		expect(emails()[0]!.element).toBe(second);
		expect((emails()[0]!.element as HTMLInputElement).value).toBe('two@example.com');
	});
});
