/**
 * The bulk bar's deletes: Delete runs the bulk trash, and Move into the Trash
 * folder is announced as a delete (so the reader leaves an open conversation in
 * the selection) while a move anywhere else is not.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxQuickActionsBar from '../PostboxQuickActionsBar.vue';

const moveSelected = vi.fn();
const trashSelected = vi.fn();

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('usePostboxBulkActions', () => ({
		count: ref(2),
		markRead: vi.fn(),
		star: vi.fn(),
		archiveSelected: vi.fn(),
		trashSelected,
		moveSelected,
		clear: vi.fn(),
	}));
	vi.stubGlobal('usePostboxFolders', () => ({
		folders: ref([
			{ _id: 'fld_inbox', role: 'inbox', name: 'Inbox' },
			{ _id: 'fld_archive', role: 'archive', name: 'Archive' },
			{ _id: 'fld_trash', role: 'trash', name: 'Trash' },
			{ _id: 'fld_custom', name: 'Receipts' },
		]),
	}));
});

beforeEach(() => {
	moveSelected.mockClear();
	trashSelected.mockClear();
});

function mountBar() {
	return mount(PostboxQuickActionsBar, {
		props: { mailboxId: 'mbx' as never, folderRole: 'inbox' },
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Transition: false,
				UiButton: {
					emits: ['click'],
					template: '<button type="button" @click="$emit(\'click\')"><slot /></button>',
				},
				UiTooltip: { template: '<span><slot /></span>' },
				Icon: { template: '<span />' },
				PostboxBulkOverflowMenu: { template: '<span />' },
				PostboxBulkSelectAllRow: { template: '<span />' },
			},
		},
	});
}

async function moveTo(wrapper: ReturnType<typeof mountBar>, label: string) {
	await wrapper
		.findAll('button')
		.find((b) => b.text() === 'Move')!
		.trigger('click');
	await wrapper
		.findAll('button')
		.find((b) => b.text() === label)!
		.trigger('click');
}

describe('PostboxQuickActionsBar deletes', () => {
	it('Delete runs the bulk trash', async () => {
		const wrapper = mountBar();
		await wrapper
			.findAll('button')
			.find((b) => b.text() === 'Delete')!
			.trigger('click');
		expect(trashSelected).toHaveBeenCalledTimes(1);
	});

	it('marks a move into Trash as a delete, and no other move', async () => {
		const wrapper = mountBar();
		await moveTo(wrapper, 'trash');
		expect(moveSelected).toHaveBeenLastCalledWith('fld_trash', true);
		await moveTo(wrapper, 'archive');
		expect(moveSelected).toHaveBeenLastCalledWith('fld_archive', false);
		await moveTo(wrapper, 'Receipts');
		expect(moveSelected).toHaveBeenLastCalledWith('fld_custom', false);
	});
});
