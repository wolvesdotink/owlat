/**
 * `useTopicForm` holds the topic list's create, edit and delete flows, which
 * used to be inline on the page as two form modals and a hand-rolled delete
 * state. One form now serves create and edit, as `useSegmentForm` does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '@owlat/api/dataModel';

type Run = ReturnType<typeof vi.fn>;
let runs: { create: Run; update: Run; remove: Run };
const showToast = vi.fn();

beforeEach(() => {
	runs = {
		create: vi.fn(async () => ({ ok: true })),
		update: vi.fn(async () => ({ ok: true })),
		remove: vi.fn(async () => ({ ok: true })),
	};
	const order = [runs.create, runs.update, runs.remove];
	let call = 0;
	vi.stubGlobal('useBackendOperation', () => ({ run: order[call++] }));
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
	vi.stubGlobal('useToast', () => ({ showToast }));
	showToast.mockClear();
});

const { useTopicForm } = await import('../useTopicForm');

const topic = {
	_id: 'tp_1' as Id<'topics'>,
	name: 'Product updates',
	description: 'Release notes',
	requireDoubleOptIn: true,
	contactCount: 3,
};

describe('useTopicForm create and edit', () => {
	it('refuses a blank name without calling the backend', async () => {
		const form = useTopicForm();
		form.openCreateModal();
		form.topicForm.name = '   ';
		await form.handleSave();
		expect(form.topicErrors.name).toBe('dashboard.audience.topics.index.validation.nameRequired');
		expect(runs.create).not.toHaveBeenCalled();
		expect(form.isTopicModalOpen.value).toBe(true);
	});

	it('creates with the trimmed fields and an explicit double opt-in choice', async () => {
		const form = useTopicForm();
		form.openCreateModal();
		form.topicForm.name = ' News ';
		await form.handleSave();
		expect(runs.create).toHaveBeenCalledWith({
			name: 'News',
			description: undefined,
			requireDoubleOptIn: false,
		});
		expect(runs.update).not.toHaveBeenCalled();
		expect(showToast).toHaveBeenCalledWith('dashboard.audience.topics.index.toasts.created');
		expect(form.isTopicModalOpen.value).toBe(false);
	});

	it('edits the topic it was opened with', async () => {
		const form = useTopicForm();
		form.openEditModal(topic);
		expect(form.isEditMode.value).toBe(true);
		expect(form.topicForm.name).toBe('Product updates');
		form.topicForm.requireDoubleOptIn = false;
		await form.handleSave();
		expect(runs.update).toHaveBeenCalledWith({
			topicId: 'tp_1',
			name: 'Product updates',
			description: 'Release notes',
			requireDoubleOptIn: false,
		});
		expect(showToast).toHaveBeenCalledWith('dashboard.audience.topics.index.toasts.updated');
	});

	it('starts a create from a clean form after an edit', () => {
		const form = useTopicForm();
		form.openEditModal(topic);
		form.openCreateModal();
		expect(form.isEditMode.value).toBe(false);
		expect(form.topicForm).toMatchObject({ id: '', name: '', requireDoubleOptIn: false });
	});

	it('keeps the modal open when the save fails', async () => {
		runs.create.mockResolvedValueOnce({ ok: false });
		const form = useTopicForm();
		form.openCreateModal();
		form.topicForm.name = 'News';
		await form.handleSave();
		expect(form.isTopicModalOpen.value).toBe(true);
		expect(form.isSaving.value).toBe(false);
	});
});

describe('useTopicForm delete', () => {
	it('deletes the chosen topic and closes the dialog', async () => {
		const form = useTopicForm();
		form.openDeleteModal(topic);
		expect(form.deleteTarget.value).toEqual({
			id: 'tp_1',
			name: 'Product updates',
			contactCount: 3,
		});
		await form.handleDelete();
		expect(runs.remove).toHaveBeenCalledWith({ topicId: 'tp_1' });
		expect(form.isDeleteModalOpen.value).toBe(false);
		expect(form.deleteTarget.value).toBeNull();
	});

	it('keeps the dialog open when the delete fails', async () => {
		runs.remove.mockResolvedValueOnce({ ok: false });
		const form = useTopicForm();
		form.openDeleteModal(topic);
		await form.handleDelete();
		expect(form.isDeleteModalOpen.value).toBe(true);
		expect(form.isDeleting.value).toBe(false);
	});
});
