// @vitest-environment happy-dom
/**
 * PluginSettingsField — one schema-rendered plugin settings control.
 *
 * Covers the accessibility wiring (label association, aria-describedby,
 * aria-required, role=switch), the secret-field behaviour (read-only, presence
 * only, names the environment variable, offers no input), and SSR-safety
 * (renders to a string with no window/document access).
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

	it('names a secret without pointing a <label for> at a non-labelable element', () => {
		// The presence indicator is a <p>, which is not a labelable form element, so
		// a <label for> aimed at it would compute no accessible name. Like the
		// boolean branch it must be named with aria-labelledby instead.
		const field: Field = {
			kind: 'secret',
			key: 'apiKey',
			envVar: 'PLUGIN_API_KEY',
			label: 'API key',
		};
		const wrapper = mountField(field, { secretSet: false });
		expect(wrapper.find('label').exists()).toBe(false);
		const control = wrapper.get('[role="status"]');
		const labelledBy = control.attributes('aria-labelledby');
		expect(labelledBy).toBeTruthy();
		expect(wrapper.get(`#${labelledBy}`).text()).toContain('API key');
	});

	it('associates the "set this variable" hint with the secret control', () => {
		const field: Field = {
			kind: 'secret',
			key: 'apiKey',
			envVar: 'PLUGIN_API_KEY',
			label: 'API key',
		};
		const wrapper = mountField(field, { secretSet: false });
		const describedBy = wrapper.get('[role="status"]').attributes('aria-describedby');
		expect(describedBy).toBeTruthy();
		const described = (describedBy ?? '')
			.split(' ')
			.map((id) => wrapper.get(`#${id}`).text())
			.join(' ');
		expect(described).toContain('PLUGIN_API_KEY');
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
	const secretField: Field = {
		kind: 'secret',
		key: 'apiKey',
		envVar: 'PLUGIN_API_KEY',
		label: 'API key',
	};

	it('offers no input at all, so a credential can never be typed into Owlat', () => {
		const wrapper = mountField(secretField, { modelValue: '', secretSet: true });
		expect(wrapper.find('input').exists()).toBe(false);
		expect(wrapper.find('textarea').exists()).toBe(false);
	});

	it('reports the environment variable as set', () => {
		const wrapper = mountField(secretField, { modelValue: '', secretSet: true });
		expect(wrapper.text()).toContain('Set in the environment');
		expect(wrapper.text()).toContain('PLUGIN_API_KEY');
	});

	it('reports an absent environment variable and names what to set', () => {
		const wrapper = mountField(secretField, { secretSet: false });
		expect(wrapper.text()).toContain('Not set');
		expect(wrapper.text()).toContain('PLUGIN_API_KEY');
	});
});

describe('PluginSettingsField emits', () => {
	it('emits the typed number for a number field', async () => {
		const field: Field = { kind: 'number', key: 'timeout', label: 'Timeout', min: 1, max: 120 };
		const wrapper = mountField(field, { modelValue: 30 });
		const input = wrapper.get('input[type="number"]');
		// Schema numbers permit non-integer values, so the mobile keyboard hint is
		// decimal (a period key), not the integer-only numeric mode.
		expect(input.attributes('inputmode')).toBe('decimal');
		// And step="any" lifts the native step=1 constraint that would otherwise
		// make a fractional value a stepMismatch and block form submission.
		expect(input.attributes('step')).toBe('any');
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

describe('PluginSettingsField unset select placeholder', () => {
	const field: Field = {
		kind: 'select',
		key: 'region',
		label: 'Region',
		options: [
			{ value: 'eu', label: 'EU' },
			{ value: 'us', label: 'US' },
		],
	};

	it('shows a disabled "Select…" placeholder when no value is chosen', () => {
		const wrapper = mountField(field, { modelValue: '' });
		const placeholder = wrapper.get('option[value=""]');
		expect(placeholder.text()).toBe('Select…');
		expect(placeholder.attributes('disabled')).toBeDefined();
	});

	it('drops the placeholder once a real value is selected', () => {
		const wrapper = mountField(field, { modelValue: 'us' });
		expect(wrapper.find('option[value=""]').exists()).toBe(false);
	});
});

describe('PluginSettingsField SSR', () => {
	it('renders to a string server-side without touching the DOM', async () => {
		const field: Field = {
			kind: 'secret',
			key: 'apiKey',
			envVar: 'PLUGIN_API_KEY',
			label: 'API key',
			description: 'Provider credential',
			required: true,
		};
		const app = createSSRApp({
			render: () => h(PluginSettingsField, { field, modelValue: '', secretSet: true }),
		});
		const html = await renderToString(app);
		expect(html).toContain('API key');
		expect(html).toContain('PLUGIN_API_KEY');
		// There is no credential input, so nothing to prefill and nothing to leak.
		expect(html).not.toContain('type="password"');
	});
});
