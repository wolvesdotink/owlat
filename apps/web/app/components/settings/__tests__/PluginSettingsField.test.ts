// @vitest-environment happy-dom
/**
 * PluginSettingsField — one schema-rendered plugin settings control.
 *
 * Covers the accessibility wiring (label association, aria-describedby,
 * aria-required, role=switch), the secret-field behaviour (starts blank, hint
 * reflects stored state, emits the typed value), and SSR-safety (renders to a
 * string with no window/document access).
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { renderToString } from '@vue/server-renderer';
import { createSSRApp, h } from 'vue';
import type { PluginSettingsField as Field } from '@owlat/plugin-kit';
import PluginSettingsField from '../PluginSettingsField.vue';

function mountField(field: Field, props: Record<string, unknown> = {}) {
	return mount(PluginSettingsField, {
		props: { field, modelValue: props.modelValue ?? '', ...props },
		global: { stubs: { Icon: true } },
	});
}

describe('PluginSettingsField accessibility', () => {
	it('associates a text field label with its input via for/id', () => {
		const field: Field = { kind: 'string', key: 'endpoint', label: 'Endpoint' };
		const wrapper = mountField(field, { modelValue: 'https://x' });
		const input = wrapper.get('input[type="text"]');
		const label = wrapper.get('label');
		expect(label.attributes('for')).toBe(input.attributes('id'));
		expect((input.element as HTMLInputElement).value).toBe('https://x');
	});

	it('marks a required field with aria-required and a description via aria-describedby', () => {
		const field: Field = {
			kind: 'string',
			key: 'endpoint',
			label: 'Endpoint',
			description: 'The base URL',
			required: true,
		};
		const wrapper = mountField(field);
		const input = wrapper.get('input[type="text"]');
		expect(input.attributes('aria-required')).toBe('true');
		const descId = input.attributes('aria-describedby');
		expect(descId).toBeTruthy();
		expect(wrapper.get(`#${descId}`).text()).toBe('The base URL');
	});

	it('renders a boolean as a role=switch button named by its label', () => {
		const field: Field = { kind: 'boolean', key: 'verbose', label: 'Verbose' };
		const wrapper = mountField(field, { modelValue: true });
		const button = wrapper.get('button[role="switch"]');
		expect(button.attributes('aria-checked')).toBe('true');
		const labelledBy = button.attributes('aria-labelledby');
		expect(wrapper.get(`#${labelledBy}`).text()).toBe('Verbose');
	});
});

describe('PluginSettingsField secret handling', () => {
	it('starts blank and shows the saved-value hint when a secret is stored', () => {
		const field: Field = { kind: 'secret', key: 'apiKey', label: 'API key' };
		const wrapper = mountField(field, { modelValue: '', secretSet: true });
		const input = wrapper.get('input[type="password"]');
		expect((input.element as HTMLInputElement).value).toBe('');
		expect(input.attributes('placeholder')).toBe('Leave blank to keep the saved value');
		expect(wrapper.text()).toContain('A value is saved');
	});

	it('shows the no-value hint and a plain prompt when no secret is stored', () => {
		const field: Field = { kind: 'secret', key: 'apiKey', label: 'API key' };
		const wrapper = mountField(field, { secretSet: false });
		expect(wrapper.get('input[type="password"]').attributes('placeholder')).toBe('Enter a value');
		expect(wrapper.text()).toContain('No value saved yet');
	});
});

describe('PluginSettingsField emits', () => {
	it('emits the typed number for a number field', async () => {
		const field: Field = { kind: 'number', key: 'timeout', label: 'Timeout', min: 1, max: 120 };
		const wrapper = mountField(field, { modelValue: 30 });
		const input = wrapper.get('input[type="number"]');
		await input.setValue('45');
		const emitted = wrapper.emitted('update:modelValue');
		expect(emitted?.at(-1)).toEqual([45]);
	});

	it('toggles a boolean on switch click', async () => {
		const field: Field = { kind: 'boolean', key: 'verbose', label: 'Verbose' };
		const wrapper = mountField(field, { modelValue: false });
		await wrapper.get('button[role="switch"]').trigger('click');
		expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([true]);
	});

	it('emits the selected option value', async () => {
		const field: Field = {
			kind: 'select',
			key: 'region',
			label: 'Region',
			options: [
				{ value: 'eu', label: 'EU' },
				{ value: 'us', label: 'US' },
			],
		};
		const wrapper = mountField(field, { modelValue: 'eu' });
		await wrapper.get('select').setValue('us');
		expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['us']);
	});
});

describe('PluginSettingsField SSR', () => {
	it('renders to a string server-side without touching the DOM', async () => {
		const field: Field = {
			kind: 'secret',
			key: 'apiKey',
			label: 'API key',
			description: 'Provider credential',
			required: true,
		};
		const app = createSSRApp({
			render: () => h(PluginSettingsField, { field, modelValue: '', secretSet: true }),
		});
		const html = await renderToString(app);
		expect(html).toContain('API key');
		expect(html).toContain('type="password"');
		// The stored secret plaintext is never part of the rendered markup.
		expect(html).not.toContain('super-secret');
	});
});
