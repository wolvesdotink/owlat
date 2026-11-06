/**
 * The bulk bar's deletes: Delete runs the bulk trash, and Move into the Trash
 * folder is announced as a delete (so the reader leaves an open conversation in
 * the selection) while a move anywhere else is not. Over the unified folders,
 * Delete forever and Not spam reach only the selected rows the view shows.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxQuickActionsBar from '../PostboxQuickActionsBar.vue';

const moveSelected = vi.fn();
const trashSelected = vi.fn();
const purgeSelected = vi.fn();
const notSpamSelected = vi.fn();
const confirm = vi.fn(async () => true);
const selectedIds = ref<string[]>([]);

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('usePostboxBulkActions', () => ({
		count: ref(2),
		ids: selectedIds,
		markRead: vi.fn(),
		star: vi.fn(),
		archiveSelected: vi.fn(),
		trashSelected,
		moveSelected,
		purgeSelected,
		notSpamSelected,
		clear: vi.fn(),
	}));
	vi.stubGlobal('useConfirm', () => confirm);
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
	purgeSelected.mockClear();
	notSpamSelected.mockClear();
	confirm.mockClear();
	selectedIds.value = [];
});

function mountBar(
	props: Record<string, unknown> = { mailboxId: 'mbx' as never, folderRole: 'inbox' }
) {
	return mount(PostboxQuickActionsBar, {
		props,
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Transition: false,
				UiButton: {
					emits: ['click'],
					template: '<button type="button" @click="$emit(\'click\')"><slot /></button>',
				},
				UiTooltip: { template: '<span><slot /></span>' },
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

describe('PostboxQuickActionsBar over the unified folders', () => {
	const clickLabel = (wrapper: ReturnType<typeof mountBar>, label: string) =>
		wrapper
			.findAll('button')
			.find((b) => b.text() === label)!
			.trigger('click');

	it('Delete forever in All trash purges only the selected rows the view shows', async () => {
		// An Inbox pick still held when the person reaches All trash.
		selectedIds.value = ['inbox-msg', 'trash-msg'];
		const wrapper = mountBar({
			selectionScope: 'all-trash:all',
			folderRole: 'trash',
			pageIds: ['trash-msg', 'other-trash'],
		});
		await clickLabel(wrapper, 'Delete forever');
		await flushPromises();
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(purgeSelected).toHaveBeenCalledWith(['trash-msg']);
	});

	it('asks nothing and purges nothing when no selected row is in the view', async () => {
		selectedIds.value = ['inbox-msg'];
		const wrapper = mountBar({
			selectionScope: 'all-trash:all',
			folderRole: 'trash',
			pageIds: ['trash-msg'],
		});
		await clickLabel(wrapper, 'Delete forever');
		await flushPromises();
		expect(confirm).not.toHaveBeenCalled();
		expect(purgeSelected).not.toHaveBeenCalled();
	});

	it('Not spam in All spam clears the verdict on the selected rows the view shows only', async () => {
		selectedIds.value = ['inbox-msg', 'spam-msg'];
		const wrapper = mountBar({
			selectionScope: 'all-spam:all',
			folderRole: 'spam',
			pageIds: ['spam-msg'],
		});
		await clickLabel(wrapper, 'Not spam');
		expect(notSpamSelected).toHaveBeenCalledWith(['spam-msg']);
	});
});
