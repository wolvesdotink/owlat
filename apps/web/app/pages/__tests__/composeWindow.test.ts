// @vitest-environment happy-dom
/**
 * The desktop compose window (pages/compose.vue) after a send (issue #864,
 * finding 6). It used to close on `@sent`, so a mailto: message had no undo
 * window and no send sound. The composer now arms the undo window itself;
 * this page hides the composer, keeps the window open with the toast, closes
 * it once the window runs out, and takes back the draft an Undo recovers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';

import ComposePage from '../compose.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const closeComposeWindow = vi.fn(async () => {});
vi.mock('@owlat/desktop/src/compose', () => ({ closeComposeWindow }));

const ComposerStub = defineComponent({
	name: 'PostboxComposer',
	props: { seed: { type: Object, required: true } },
	emits: ['sent', 'discarded'],
	template: '<div data-testid="composer" />',
});

const ToastStub = defineComponent({
	name: 'PostboxUndoSendToast',
	props: { reopen: { type: Function, default: undefined } },
	emits: ['expired', 'undone'],
	template: '<div data-testid="toast" />',
});

beforeEach(() => {
	closeComposeWindow.mockClear();
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useHead', () => {});
	vi.stubGlobal('definePageMeta', () => {});
	vi.stubGlobal('useRoute', () => ({
		query: { to: 'ada@example.com, bob@example.com', subject: 'Hi', body: 'Line 1\nLine 2' },
	}));
	vi.stubGlobal('usePostboxMailbox', () => ({
		currentMailbox: ref({ _id: 'mbx-1' }),
		isLoading: ref(false),
	}));
});

function mountPage() {
	return mount(ComposePage, {
		global: {
			plugins: [createTestI18n()],
			components: { PostboxComposer: ComposerStub, PostboxUndoSendToast: ToastStub },
		},
	});
}

describe('desktop compose window', () => {
	it('seeds the composer from the mailto query', () => {
		const seed = mountPage().getComponent(ComposerStub).props('seed');
		expect(seed).toMatchObject({
			mailboxId: 'mbx-1',
			prefillTo: ['ada@example.com', 'bob@example.com'],
			prefillCc: [],
			prefillBcc: [],
			prefillSubject: 'Hi',
			prefillBodyHtml: 'Line 1<br>Line 2',
		});
	});

	it('stays open after a send, then closes when the undo window runs out', async () => {
		const wrapper = mountPage();
		wrapper.getComponent(ComposerStub).vm.$emit('sent', { scheduled: false });
		await nextTick();

		expect(wrapper.find('[data-testid="composer"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="toast"]').exists()).toBe(true);
		expect(closeComposeWindow).not.toHaveBeenCalled();

		wrapper.getComponent(ToastStub).vm.$emit('expired');
		await flushPromises();
		expect(closeComposeWindow).toHaveBeenCalledOnce();
	});

	it('takes back the recovered draft in the same window on Undo', async () => {
		const wrapper = mountPage();
		wrapper.getComponent(ComposerStub).vm.$emit('sent', { scheduled: false });
		await nextTick();

		// PostboxUndoSendToast hands the recovered draft to `reopen`, then emits.
		const reopen = wrapper.getComponent(ToastStub).props('reopen') as (spec: unknown) => void;
		reopen({ mailboxId: 'mbx-1', draftId: 'draft-9' });
		wrapper.getComponent(ToastStub).vm.$emit('undone');
		await flushPromises();

		expect(wrapper.getComponent(ComposerStub).props('seed')).toMatchObject({
			mailboxId: 'mbx-1',
			draftId: 'draft-9',
		});
		expect(closeComposeWindow).not.toHaveBeenCalled();
	});

	it('closes when the undo came too late and nothing was recovered', async () => {
		const wrapper = mountPage();
		wrapper.getComponent(ComposerStub).vm.$emit('sent', { scheduled: false });
		await nextTick();
		wrapper.getComponent(ToastStub).vm.$emit('undone');
		await flushPromises();
		expect(closeComposeWindow).toHaveBeenCalledOnce();
	});

	it('closes at once on a scheduled send and on discard', async () => {
		mountPage().getComponent(ComposerStub).vm.$emit('sent', { scheduled: true });
		await flushPromises();
		expect(closeComposeWindow).toHaveBeenCalledOnce();

		mountPage().getComponent(ComposerStub).vm.$emit('discarded');
		await flushPromises();
		expect(closeComposeWindow).toHaveBeenCalledTimes(2);
	});

	it('ignores an expiry while the composer is open', async () => {
		const wrapper = mountPage();
		wrapper.getComponent(ToastStub).vm.$emit('expired');
		await flushPromises();
		expect(closeComposeWindow).not.toHaveBeenCalled();
	});
});
