/**
 * The message card's ⋯ menu offers "Copy link" and, while chat is on, "Share in
 * chat…"; each hands its verb back to the reader and closes the menu.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxReaderMessageActions from '../PostboxReaderMessageActions.vue';

const flags = { chat: true };
const close = vi.fn();

beforeEach(() => {
	flags.chat = true;
	close.mockClear();
	installNuxtStubs({
		...i18nStubs,
		useToast: () => ({ showToast: vi.fn() }),
		useFeatureFlag: () => ({ isEnabled: (flag: string) => flag !== 'chat' || flags.chat }),
	});
});

function mountActions() {
	return mount(PostboxReaderMessageActions, {
		props: { messageId: 'm1', starred: false, showReplyAll: false },
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: true,
				UiButton: { template: '<button type="button"><slot /></button>' },
				PostboxOverflowMenu: {
					setup: () => ({ close }),
					template: '<div role="menu"><slot :close="close" /></div>',
				},
			},
		},
	});
}

const item = (wrapper: ReturnType<typeof mountActions>, label: string) =>
	wrapper.findAll('[role="menuitem"]').find((button) => button.text() === label);

describe('PostboxReaderMessageActions link verbs', () => {
	it('copies the link and shares it in chat from the ⋯ menu', async () => {
		const wrapper = mountActions();
		const labels = wrapper.findAll('[role="menuitem"]').map((button) => button.text());
		expect(labels.slice(0, 2)).toEqual(['Copy link', 'Share in chat…']);

		await item(wrapper, 'Copy link')!.trigger('click');
		await item(wrapper, 'Share in chat…')!.trigger('click');
		expect(wrapper.emitted('copy-link')).toHaveLength(1);
		expect(wrapper.emitted('share-in-chat')).toHaveLength(1);
		expect(close).toHaveBeenCalledTimes(2);
	});

	it('offers no chat sharing while chat is off', () => {
		flags.chat = false;
		const wrapper = mountActions();
		expect(item(wrapper, 'Copy link')).toBeDefined();
		expect(item(wrapper, 'Share in chat…')).toBeUndefined();
	});
});
