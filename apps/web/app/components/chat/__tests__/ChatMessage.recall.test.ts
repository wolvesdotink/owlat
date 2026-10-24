/**
 * The composer's ↑ opens a message's own inline editor: focused, caret at the
 * end. Saving edits that same message, Escape cancels, and either way focus
 * goes back to the composer the ↑ came from.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';

import ChatMessage from '../ChatMessage.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { ChatMessageRow } from '~/composables/chat/useChatRoom';

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useChatAttachmentDetails: () => ({ attachments: ref([]) }),
	});
});

const ME = 'user_me';
const STUBS = {
	UiAvatar: true,
	Icon: true,
	AssistantToolCalls: true,
	AssistantMarkdown: true,
	AiBudgetRefusal: true,
	ChatAttachmentChip: true,
};
// The hand-built DOM of a test (the composer, the row's host); the shared setup
// unmounts the components.
let root: HTMLElement;

beforeEach(() => {
	root = document.createElement('div');
	document.body.appendChild(root);
});

afterEach(() => {
	root.remove();
});

function message(extra: Partial<ChatMessageRow> = {}): ChatMessageRow {
	return {
		_id: 'msg_1',
		roomId: 'room_a',
		authorId: ME,
		author: { name: 'Ada Marlow', email: null, image: null },
		isAssistant: false,
		text: 'Pushed the copy changes',
		createdAt: Date.UTC(2026, 7, 21, 8, 30),
		...extra,
	} as unknown as ChatMessageRow;
}

/** A composer textarea that holds focus, then the message row beside it. */
function setup(row = message()) {
	const composer = document.createElement('textarea');
	root.appendChild(composer);
	composer.focus();
	const host = document.createElement('div');
	root.appendChild(host);
	const w = mount(ChatMessage, {
		attachTo: host,
		props: { message: row, isOwnMessage: true, currentUserId: ME },
		global: {
			plugins: [createTestI18n()],
			stubs: STUBS,
		},
	});
	return { w, composer };
}

const editor = (w: VueWrapper) => w.find('textarea');

describe('ChatMessage opened from the composer', () => {
	it('opens the editor focused, with the caret after the text', async () => {
		const { w } = setup();
		await w.setProps({ editRequested: true });
		await flushPromises();

		const field = editor(w).element as HTMLTextAreaElement;
		expect(field.value).toBe('Pushed the copy changes');
		expect(document.activeElement).toBe(field);
		expect(field.selectionStart).toBe(field.value.length);
		expect(w.emitted('editing')).toEqual([['msg_1', true]]);
	});

	it('saves the edit to the same message and hands focus back', async () => {
		const { w, composer } = setup();
		await w.setProps({ editRequested: true });
		await flushPromises();

		await editor(w).setValue('Pushed the copy changes, test runs until Friday');
		await editor(w).trigger('keydown', { key: 'Enter' });
		await flushPromises();

		expect(w.emitted('edit')).toEqual([
			['msg_1', 'Pushed the copy changes, test runs until Friday'],
		]);
		expect(editor(w).exists()).toBe(false);
		expect(document.activeElement).toBe(composer);
	});

	it('cancels on Escape without an edit, and hands focus back', async () => {
		const { w, composer } = setup();
		await w.setProps({ editRequested: true });
		await flushPromises();

		await editor(w).setValue('something else');
		await editor(w).trigger('keydown', { key: 'Escape' });
		await flushPromises();

		expect(w.emitted('edit')).toBeUndefined();
		expect(editor(w).exists()).toBe(false);
		expect(document.activeElement).toBe(composer);
	});

	it('leaves focus where a click put it', async () => {
		const { w } = setup();
		await w.setProps({ editRequested: true });
		await flushPromises();

		const elsewhere = document.createElement('button');
		root.appendChild(elsewhere);
		elsewhere.focus();
		await w
			.findAll('button')
			.find((b) => b.text() === 'Cancel')!
			.trigger('click');
		await flushPromises();

		expect(document.activeElement).toBe(elsewhere);
	});

	it('opens when the row mounts with the request already set', async () => {
		const host = document.createElement('div');
		root.appendChild(host);
		const w = mount(ChatMessage, {
			attachTo: host,
			props: { message: message(), isOwnMessage: true, currentUserId: ME, editRequested: true },
			global: {
				plugins: [createTestI18n()],
				stubs: STUBS,
			},
		});
		await flushPromises();
		expect(document.activeElement).toBe(editor(w).element);
	});

	it('does not open a deleted message', async () => {
		const { w } = setup(message({ deletedAt: 1 } as Partial<ChatMessageRow>));
		await w.setProps({ editRequested: true });
		await flushPromises();
		expect(editor(w).exists()).toBe(false);
	});
});
