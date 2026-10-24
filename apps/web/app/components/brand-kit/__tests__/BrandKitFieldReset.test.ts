/**
 * The brand kit fields carry the page's "changed from default" marker: shown
 * only when the page says the field differs, and Reset is handed back to the
 * page, which owns the draft (it stays unsaved until Save).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import ColorField from '../ColorField.vue';
import FontSelect from '../FontSelect.vue';

beforeEach(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

const mountOpts = { global: { plugins: [createTestI18n()] } };

describe('brand kit field reset', () => {
	it('shows no marker on a default colour', () => {
		const field = mount(ColorField, {
			props: { id: 'c', label: 'Primary', help: '', modelValue: '#000000', changed: false },
			...mountOpts,
		});
		expect(field.find('[data-testid="setting-reset"]').exists()).toBe(false);
	});

	it('hands Reset on a changed colour back to the page', async () => {
		const field = mount(ColorField, {
			props: { id: 'c', label: 'Primary', help: '', modelValue: '#2d7d6b', changed: true },
			...mountOpts,
		});
		const reset = field.get('[data-testid="setting-reset"] button');
		expect(reset.attributes('aria-label')).toBe('Reset Primary to its default');
		await reset.trigger('click');
		expect(field.emitted('reset')).toHaveLength(1);
		// The field itself writes nothing; the page resets its draft.
		expect(field.emitted('update:modelValue')).toBeUndefined();
	});

	it('holds Reset while the kit is saving', () => {
		const font = mount(FontSelect, {
			props: {
				id: 'f',
				label: 'Body font',
				modelValue: 'Georgia, serif',
				changed: true,
				disabled: true,
			},
			...mountOpts,
		});
		expect(font.get('[data-testid="setting-reset"] button').attributes('disabled')).toBeDefined();
	});
});
