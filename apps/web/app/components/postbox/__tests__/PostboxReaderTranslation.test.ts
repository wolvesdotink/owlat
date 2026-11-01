/**
 * The reader's translation panel renders the model's answer as TEXT: markup in
 * a translation stays visible characters, never elements.
 */
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { ReaderTranslationState } from '~/composables/postbox/usePostboxReaderTranslation';
import PostboxReaderTranslation from '../PostboxReaderTranslation.vue';

vi.stubGlobal('useI18n', i18nStubs.useI18n);

function mountPanel(state: ReaderTranslationState) {
	return mount(PostboxReaderTranslation, {
		props: { state, language: 'English' },
		global: {
			plugins: [createTestI18n()],
			stubs: { UiButton: { template: '<button><slot /></button>' } },
		},
	});
}

describe('PostboxReaderTranslation', () => {
	it('renders nothing while idle', () => {
		expect(mountPanel({ status: 'idle' }).html()).toBe('<!--v-if-->');
	});

	it('shows the translation as text, line breaks kept, markup inert', () => {
		const wrapper = mountPanel({
			status: 'done',
			text: 'Hello\n<img src=x onerror=alert(1)>',
			truncated: false,
		});
		const text = wrapper.get('[data-testid="postbox-translation-text"]');
		expect(text.element.textContent).toBe('Hello\n<img src=x onerror=alert(1)>');
		expect(text.find('img').exists()).toBe(false);
		expect(wrapper.text()).toContain('Translated to English');
		expect(wrapper.text()).toContain('Machine translation. The original is below.');
	});

	it('says when only the beginning was translated', () => {
		const wrapper = mountPanel({ status: 'done', text: 'Hi', truncated: true });
		expect(wrapper.text()).toContain('the beginning of a long message');
	});

	it('offers a retry after a failure, and closes', async () => {
		const wrapper = mountPanel({
			status: 'error',
			messageKey: 'postbox.reader.translation.failed',
		});
		expect(wrapper.text()).toContain('The translation did not come through');
		await wrapper.get('button:not([data-testid])').trigger('click');
		expect(wrapper.emitted('retry')).toHaveLength(1);
		await wrapper.get('[data-testid="postbox-translation-close"]').trigger('click');
		expect(wrapper.emitted('close')).toHaveLength(1);
	});
});
