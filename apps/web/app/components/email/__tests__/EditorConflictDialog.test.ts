// @vitest-environment happy-dom
/**
 * The stale-revision choice in the email editors: both answers are offered in
 * the user's language, each emits its own event, and a choice in progress
 * cannot be dismissed or picked twice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

import EditorConflictDialog from '../EditorConflictDialog.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

const modalStub = {
	props: ['open', 'title', 'persistent'],
	emits: ['update:open'],
	template:
		'<div v-if="open" :data-persistent="String(persistent)"><h2>{{ title }}</h2><slot /><div class="footer"><slot name="footer" /></div><button class="close" @click="$emit(\'update:open\', false)" /></div>',
};
const buttonStub = {
	props: ['loading', 'disabled', 'variant'],
	emits: ['click'],
	template: '<button :disabled="disabled || loading" @click="$emit(\'click\')"><slot /></button>',
};

beforeEach(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

function mountDialog(isResolving = false) {
	return mount(EditorConflictDialog, {
		props: { open: true, isResolving },
		global: {
			plugins: [createTestI18n()],
			stubs: { UiModal: modalStub, UiButton: buttonStub },
		},
	});
}

const button = (wrapper: ReturnType<typeof mountDialog>, label: string) =>
	wrapper.findAll('.footer button').find((b) => b.text() === label)!;

describe('EditorConflictDialog', () => {
	it('offers both answers in the resolved copy', () => {
		const wrapper = mountDialog();

		expect(wrapper.text()).toContain('This email changed while you were editing');
		expect(button(wrapper, 'Keep my version').exists()).toBe(true);
		expect(button(wrapper, 'Load latest').exists()).toBe(true);
		expectFullyLocalized(wrapper);
	});

	it('emits keep, load and close', async () => {
		const wrapper = mountDialog();

		await button(wrapper, 'Keep my version').trigger('click');
		await button(wrapper, 'Load latest').trigger('click');
		await wrapper.find('.close').trigger('click');

		expect(wrapper.emitted('keep')).toHaveLength(1);
		expect(wrapper.emitted('load')).toHaveLength(1);
		expect(wrapper.emitted('close')).toHaveLength(1);
	});

	it('locks both answers while one is being applied', () => {
		const wrapper = mountDialog(true);

		expect(button(wrapper, 'Keep my version').attributes('disabled')).toBeDefined();
		expect(button(wrapper, 'Load latest').attributes('disabled')).toBeDefined();
		expect(wrapper.find('[data-persistent="true"]').exists()).toBe(true);
	});
});
