/**
 * ↑ in the empty chat box asks the room to open your last message for editing.
 * It never touches the draft, leaves every other ↑ alone (text typed, files
 * attached, a modifier held, an IME composing), and says so when none of the
 * loaded messages is yours but older history may hold one.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';

import ChatInput from '../ChatInput.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { ChatRecallTarget } from '~/utils/composerRecall';

let recallLast: ReturnType<typeof vi.fn<() => ChatRecallTarget>>;

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useChatMentionSearch: () => ({ candidates: ref([]) }),
		useChatAttachments: () => ({ isUploading: ref(false), uploadFile: async () => 'asset_1' }),
	});
});

beforeEach(() => {
	recallLast = vi.fn<() => ChatRecallTarget>(() => ({ kind: 'edit', messageId: 'msg_1' }));
});

function mountInput() {
	return mount(ChatInput, {
		props: { send: async () => ({ ok: true }), recallLast },
		global: {
			plugins: [createTestI18n()],
			stubs: { ChatMentionPicker: true, UiSpinner: true },
		},
	});
}

async function press(w: VueWrapper, init: KeyboardEventInit) {
	const event = new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init });
	w.get('textarea').element.dispatchEvent(event);
	await flushPromises();
	return event;
}

const notice = (w: VueWrapper) => w.find('[data-testid="chat-recall-notice"]');

describe('ChatInput ↑ recall', () => {
	it('asks for the last message from an empty box and takes the key', async () => {
		const w = mountInput();
		const event = await press(w, { key: 'ArrowUp' });
		expect(recallLast).toHaveBeenCalledTimes(1);
		expect(event.defaultPrevented).toBe(true);
		expect((w.get('textarea').element as HTMLTextAreaElement).value).toBe('');
		expect(notice(w).exists()).toBe(false);
	});

	it('leaves ↑ to the caret while there is text', async () => {
		const w = mountInput();
		await w.get('textarea').setValue('half a thought');
		const event = await press(w, { key: 'ArrowUp' });
		expect(recallLast).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	it('leaves ↑ alone while files are attached', async () => {
		const w = mountInput();
		const input = w.get('input[type="file"]');
		Object.defineProperty(input.element, 'files', {
			configurable: true,
			value: [new File(['x'], 'plan.pdf', { type: 'application/pdf' })],
		});
		await input.trigger('change');
		await flushPromises();
		await press(w, { key: 'ArrowUp' });
		expect(recallLast).not.toHaveBeenCalled();
	});

	it('ignores modified arrows, ↓ and an IME composition', async () => {
		const w = mountInput();
		await press(w, { key: 'ArrowUp', shiftKey: true });
		await press(w, { key: 'ArrowUp', altKey: true });
		await press(w, { key: 'ArrowUp', metaKey: true });
		await press(w, { key: 'ArrowUp', ctrlKey: true });
		await press(w, { key: 'ArrowDown' });
		await press(w, { key: 'ArrowUp', isComposing: true });
		expect(recallLast).not.toHaveBeenCalled();
	});

	it('does nothing visible when the room has nothing to open', async () => {
		recallLast.mockReturnValue({ kind: 'none' });
		const w = mountInput();
		const event = await press(w, { key: 'ArrowUp' });
		expect(recallLast).toHaveBeenCalledTimes(1);
		expect(event.defaultPrevented).toBe(false);
		expect(notice(w).exists()).toBe(false);
	});

	it('points to older history when none of the loaded messages is yours', async () => {
		recallLast.mockReturnValue({ kind: 'notLoaded', canLoadEarlier: true });
		const w = mountInput();
		const event = await press(w, { key: 'ArrowUp' });
		expect(event.defaultPrevented).toBe(false);
		expect(notice(w).text()).toBe(
			'None of the recent messages is yours to edit. Load earlier messages to look further back.'
		);
		// The notice sits in a polite live region, and typing clears it.
		expect(notice(w).element.parentElement?.getAttribute('aria-live')).toBe('polite');
		await w.get('textarea').setValue('n');
		await w.get('textarea').trigger('input');
		expect(notice(w).exists()).toBe(false);
	});

	it('does not offer earlier messages once none can be loaded', async () => {
		recallLast.mockReturnValue({ kind: 'notLoaded', canLoadEarlier: false });
		const w = mountInput();
		await press(w, { key: 'ArrowUp' });
		expect(notice(w).text()).toBe('None of the messages shown here is yours to edit.');
	});
});
