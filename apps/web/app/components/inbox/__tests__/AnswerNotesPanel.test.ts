// @vitest-environment happy-dom
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import AnswerNotesPanel from '../AnswerNotesPanel.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { ThreadNotes } from '~/composables/useThreadNotes';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});
enableAutoUnmount(afterEach);

/**
 * Answer mode's Note tab stays mounted while Reply shows, so a half-written
 * note survives the switch, and showing it puts the cursor in the note box.
 */
const focus = vi.fn();
const ComposerStub = {
	name: 'InboxNoteComposer',
	template: '<div data-testid="note-box" />',
	methods: { focus },
};
const notes = {
	notes: ref([]),
	isLoading: ref(false),
	error: ref(null),
	refetch: vi.fn(),
	post: vi.fn(async () => true),
	candidatesFor: () => [],
} as unknown as ThreadNotes;

function mountPanel(active: boolean) {
	return mount(AnswerNotesPanel, {
		props: { notes, isAdmin: true, active },
		global: {
			plugins: [createTestI18n()],
			stubs: {
				InboxNoteComposer: ComposerStub,
				InboxNoteList: true,
				UiQueryBoundary: { template: '<div><slot name="empty" /></div>' },
			},
		},
	});
}

describe('AnswerNotesPanel', () => {
	it('hides without unmounting on Reply, and focuses the note box when shown', async () => {
		focus.mockClear();
		const wrapper = mountPanel(false);
		await flushPromises();
		const root = wrapper.get('[data-testid="answer-notes-panel"]').element as HTMLElement;
		expect(root.style.display).toBe('none');
		expect(wrapper.find('[data-testid="note-box"]').exists()).toBe(true);
		expect(focus).not.toHaveBeenCalled();

		await wrapper.setProps({ active: true });
		await flushPromises();
		expect(root.style.display).toBe('');
		expect(focus).toHaveBeenCalledTimes(1);
	});

	it('focuses the note box when it opens straight on the Note tab', async () => {
		focus.mockClear();
		mountPanel(true);
		await flushPromises();
		expect(focus).toHaveBeenCalledTimes(1);
	});
});
