import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

interface TopicRow {
	_id: Id<'topics'>;
	name: string;
	description?: string;
	requireDoubleOptIn?: boolean;
	contactCount: number;
}

/**
 * Create, edit and delete for subscription topics: the one form modal (create
 * or edit), its validation, the delete confirmation and the toasts. The topic
 * counterpart of `useSegmentForm`, which the segments list uses the same way.
 */
export function useTopicForm() {
	const { t } = useI18n();
	const { showToast } = useToast();

	const { run: createTopic } = useBackendOperation(api.topics.topics.create, {
		label: () => t('dashboard.audience.topics.index.operations.create'),
	});
	const { run: updateTopic } = useBackendOperation(api.topics.topics.update, {
		label: () => t('dashboard.audience.topics.index.operations.update'),
	});
	const { run: deleteTopic } = useBackendOperation(api.topics.topics.remove, {
		label: () => t('dashboard.audience.topics.index.operations.delete'),
	});

	// ─── Create/Edit Modal ─────────────────────────────────────────────

	const isTopicModalOpen = ref(false);
	const isEditMode = ref(false);
	const topicForm = reactive({
		id: '' as Id<'topics'> | '',
		name: '',
		description: '',
		requireDoubleOptIn: false,
	});
	const topicErrors = reactive({ name: '', general: '' });
	const isSaving = ref(false);

	const openModal = (values: typeof topicForm, editing: boolean) => {
		Object.assign(topicForm, values);
		topicErrors.name = '';
		topicErrors.general = '';
		isEditMode.value = editing;
		isTopicModalOpen.value = true;
	};

	const openCreateModal = () =>
		openModal({ id: '', name: '', description: '', requireDoubleOptIn: false }, false);

	const openEditModal = (topic: TopicRow) =>
		openModal(
			{
				id: topic._id,
				name: topic.name,
				description: topic.description || '',
				requireDoubleOptIn: topic.requireDoubleOptIn || false,
			},
			true
		);

	const closeTopicModal = () => {
		isTopicModalOpen.value = false;
	};

	const handleSave = async () => {
		topicErrors.name = '';
		topicErrors.general = '';
		const name = topicForm.name.trim();
		if (!name) {
			topicErrors.name = t('dashboard.audience.topics.index.validation.nameRequired');
			return;
		}
		const description = topicForm.description.trim() || undefined;

		isSaving.value = true;
		// Send the explicit boolean: `|| undefined` would coerce an unchecked box
		// to undefined, which the backend defaults to `true` (DOI forced on).
		const { requireDoubleOptIn } = topicForm;
		const result =
			isEditMode.value && topicForm.id
				? await updateTopic({ topicId: topicForm.id, name, description, requireDoubleOptIn })
				: await createTopic({ name, description, requireDoubleOptIn });
		isSaving.value = false;
		if (!result.ok) return;

		showToast(
			t(
				isEditMode.value
					? 'dashboard.audience.topics.index.toasts.updated'
					: 'dashboard.audience.topics.index.toasts.created',
				{ name }
			)
		);
		closeTopicModal();
	};

	// ─── Delete Confirmation ───────────────────────────────────────────

	const isDeleteModalOpen = ref(false);
	const deleteTarget = ref<{ id: Id<'topics'>; name: string; contactCount: number } | null>(null);
	const isDeleting = ref(false);

	const openDeleteModal = (topic: TopicRow) => {
		deleteTarget.value = { id: topic._id, name: topic.name, contactCount: topic.contactCount };
		isDeleteModalOpen.value = true;
	};

	const closeDeleteModal = () => {
		if (isDeleting.value) return;
		isDeleteModalOpen.value = false;
		deleteTarget.value = null;
	};

	const handleDelete = async () => {
		const target = deleteTarget.value;
		if (!target || isDeleting.value) return;

		isDeleting.value = true;
		const result = await deleteTopic({ topicId: target.id });
		isDeleting.value = false;
		if (!result.ok) return;
		showToast(t('dashboard.audience.topics.index.toasts.deleted', { name: target.name }));
		closeDeleteModal();
	};

	return {
		isTopicModalOpen,
		isEditMode,
		topicForm,
		topicErrors,
		isSaving,
		openCreateModal,
		openEditModal,
		closeTopicModal,
		handleSave,
		isDeleteModalOpen,
		deleteTarget,
		isDeleting,
		openDeleteModal,
		closeDeleteModal,
		handleDelete,
	};
}
