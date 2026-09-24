// @vitest-environment happy-dom
/**
 * The template editor's Publish / Unpublish button. Publish puts the stored
 * HTML live, so it waits for unsaved edits to be saved. Unpublish must not:
 * the backend refuses to save a published template, so holding Unpublish
 * while dirty left the edits with no way to be saved or published.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

import TemplatePublishButton from '../TemplatePublishButton.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

const buttonStub = {
	props: ['loading', 'disabled', 'variant', 'title'],
	emits: ['click'],
	template:
		'<button :disabled="disabled || loading" :title="title" @click="$emit(\'click\')"><slot /></button>',
};

beforeEach(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

function mountButton(props: {
	isPublished: boolean;
	hasChanges: boolean;
	hasStoredHtml?: boolean;
}) {
	return mount(TemplatePublishButton, {
		props: { hasStoredHtml: true, loading: false, ...props },
		global: {
			plugins: [createTestI18n()],
			stubs: { UiButton: buttonStub, Icon: true },
		},
	});
}

describe('TemplatePublishButton', () => {
	it('holds Publish while there are unsaved changes and says to save first', async () => {
		const wrapper = mountButton({ isPublished: false, hasChanges: true });
		const button = wrapper.get('button');

		expect(button.text()).toBe('Publish');
		expect(button.attributes('disabled')).toBeDefined();
		expect(button.attributes('title')).toBe('Save your changes before publishing');
		await button.trigger('click');
		expect(wrapper.emitted('toggle')).toBeUndefined();
		expectFullyLocalized(wrapper);
	});

	it('keeps Unpublish enabled with unsaved changes', async () => {
		const wrapper = mountButton({ isPublished: true, hasChanges: true });
		const button = wrapper.get('button');

		expect(button.text()).toBe('Unpublish');
		expect(button.attributes('disabled')).toBeUndefined();
		expect(button.attributes('title')).toBeUndefined();
		await button.trigger('click');
		expect(wrapper.emitted('toggle')).toHaveLength(1);
	});

	it('holds Publish until the email has stored HTML', () => {
		const wrapper = mountButton({ isPublished: false, hasChanges: false, hasStoredHtml: false });

		expect(wrapper.get('button').attributes('disabled')).toBeDefined();
	});

	it('enables Publish on a saved email', async () => {
		const wrapper = mountButton({ isPublished: false, hasChanges: false });
		const button = wrapper.get('button');

		expect(button.attributes('disabled')).toBeUndefined();
		await button.trigger('click');
		expect(wrapper.emitted('toggle')).toHaveLength(1);
	});
});
