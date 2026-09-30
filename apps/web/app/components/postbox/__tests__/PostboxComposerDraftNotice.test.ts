// @vitest-environment happy-dom
/**
 * The composer's draft notice (#895, #896): one sentence per state, a retry
 * only where retrying can help, and one row in the narrow popup. The sentence
 * wraps inside its own column; it must not claim a whole row of its own and
 * push the icon and the action onto separate lines.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxComposerDraftNotice from '../PostboxComposerDraftNotice.vue';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

function mountNotice(notice: 'load_failed' | 'missing' | 'not_sent' | 'not_saved' | null) {
	return mount(PostboxComposerDraftNotice, {
		props: { notice },
		global: {
			plugins: [createTestI18n()],
			components: { UiButton: { template: '<button><slot /></button>' } },
			stubs: { Icon: true },
		},
	});
}

describe('PostboxComposerDraftNotice', () => {
	it('renders nothing without a notice', () => {
		expect(mountNotice(null).find('[data-testid="composer-draft-notice"]').exists()).toBe(false);
	});

	it('offers Try again for a failed load, on the same row as the sentence', async () => {
		const wrapper = mountNotice('load_failed');
		const notice = wrapper.get('[data-testid="composer-draft-notice"]');
		expect(notice.attributes('role')).toBe('alert');
		expect(notice.text()).toContain("This draft couldn't be loaded.");

		const [icon, text, action] = notice.element.children;
		expect(icon!.tagName.toLowerCase()).toBe('icon-stub');
		// The sentence takes the remaining width and wraps inside it.
		expect(text!.classList).toContain('flex-1');
		expect(text!.classList).toContain('min-w-0');
		expect(action!.textContent).toBe('Try again');

		await wrapper.get('button').trigger('click');
		expect(wrapper.emitted('retry')).toHaveLength(1);
	});

	it('says the draft is gone, with nothing to retry', () => {
		const wrapper = mountNotice('missing');
		expect(wrapper.text()).toContain('This draft no longer exists');
		expect(wrapper.find('button').exists()).toBe(false);
	});

	it('says nothing was sent when the final save failed', () => {
		const wrapper = mountNotice('not_sent');
		expect(wrapper.text()).toContain('so nothing was sent');
		expect(wrapper.find('button').exists()).toBe(false);
	});
});
