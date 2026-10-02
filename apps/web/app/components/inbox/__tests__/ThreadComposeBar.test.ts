// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import ThreadComposeBar from '../ThreadComposeBar.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { ThreadNotes } from '~/composables/useThreadNotes';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

/** The end of a Team Inbox thread: Reply (to Answer mode) beside an internal Note. */
const notes = { post: vi.fn(async () => true), candidatesFor: () => [] } as unknown as ThreadNotes;
const ComposerStub = {
	name: 'InboxNoteComposer',
	template: '<div data-testid="note-box" />',
	methods: { focus: () => {} },
};

function mountBar(replyLabel: string | null) {
	return mount(ThreadComposeBar, {
		props: { notes, replyLabel },
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: true, InboxNoteComposer: ComposerStub },
		},
	});
}

describe('ThreadComposeBar', () => {
	it('offers Reply beside Note, and Reply goes to Answer mode', async () => {
		const wrapper = mountBar('Reply to Ines Weber');
		await wrapper.get('[data-testid="thread-reply-open"]').trigger('click');
		expect(wrapper.emitted('reply')).toHaveLength(1);
		expect(wrapper.get('[data-testid="thread-note-open"]').text()).toContain('Add internal note');
		expect(wrapper.find('[data-testid="note-box"]').exists()).toBe(false);
	});

	it('opens the note box in place, also when there is nothing to reply to', async () => {
		const wrapper = mountBar(null);
		expect(wrapper.find('[data-testid="thread-reply-open"]').exists()).toBe(false);
		await wrapper.get('[data-testid="thread-note-open"]').trigger('click');
		expect(wrapper.find('[data-testid="note-box"]').exists()).toBe(true);
		expect(wrapper.get('[data-testid="thread-note-open"]').attributes('aria-expanded')).toBe(
			'true'
		);
	});
});
