// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import ThreadNote, { type ThreadNoteView } from '../ThreadNote.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useRoute: () => ({ hash: '' }),
	});
});

/**
 * An internal note between the messages: never mistakable for mail (it says
 * "Internal note"), @mentions stand out, its author may edit it, and a deleted
 * one keeps its place as "Note deleted" with no text.
 */
function note(over: Partial<ThreadNoteView> = {}): ThreadNoteView {
	return {
		_id: 'n1' as ThreadNoteView['_id'],
		authorId: 'u_ada',
		authorName: 'Ada Marlow',
		authorEmail: 'ada@example.com',
		authorImage: null,
		body: 'Refund queued, @ben please confirm.',
		createdAt: Date.now(),
		editedAt: null,
		isDeleted: false,
		...over,
	};
}

const EditorStub = {
	name: 'InboxNoteComposer',
	props: ['submit', 'initialBody', 'editing'],
	template: '<div data-testid="editor">{{ initialBody }}</div>',
};

function mountNote(props: Record<string, unknown>) {
	return mount(ThreadNote, {
		props,
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: true, UiAvatar: true, InboxNoteComposer: EditorStub },
		},
	});
}

describe('ThreadNote', () => {
	it('says it is an internal note and emphasises mentions', () => {
		const wrapper = mountNote({ note: note() });
		expect(wrapper.text()).toContain('Internal note');
		expect(wrapper.text()).toContain('Ada Marlow');
		const mention = wrapper.get('[data-testid="thread-note-body"] span');
		expect(mention.text()).toBe('@ben');
		expect(mention.classes()).toContain('text-brand');
		expect(wrapper.find('[data-testid="thread-note-edit"]').exists()).toBe(false);
	});

	it('lets its author edit in place and asks the list to delete', async () => {
		const save = vi.fn(async () => true);
		const wrapper = mountNote({ note: note(), canEdit: true, canDelete: true, save });
		await wrapper.get('[data-testid="thread-note-delete"]').trigger('click');
		expect(wrapper.emitted('delete')).toHaveLength(1);
		await wrapper.get('[data-testid="thread-note-edit"]').trigger('click');
		expect(wrapper.get('[data-testid="editor"]').text()).toBe(
			'Refund queued, @ben please confirm.'
		);
		// While editing, the note's own actions step aside.
		expect(wrapper.find('[data-testid="thread-note-delete"]').exists()).toBe(false);
	});

	it('shows a deleted note as a tombstone without actions', () => {
		const wrapper = mountNote({
			note: note({ isDeleted: true, body: '' }),
			canEdit: true,
			canDelete: true,
		});
		expect(wrapper.get('[data-testid="thread-note-deleted"]').text()).toBe('Note deleted');
		expect(wrapper.find('[data-testid="thread-note-delete"]').exists()).toBe(false);
	});

	it('marks an edited note and names a former teammate', () => {
		const wrapper = mountNote({
			note: note({ editedAt: Date.now(), authorName: null, authorEmail: null }),
		});
		expect(wrapper.text()).toContain('(edited)');
		expect(wrapper.text()).toContain('Former teammate');
	});
});
