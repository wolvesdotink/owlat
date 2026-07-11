import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FilterLogic, FilterCondition, SegmentFilters } from './useSegmentFilters';
import { conditionEditorModuleFor } from './conditions';
import type { Condition } from './conditions';

/**
 * Composable for managing segment CRUD operations:
 * form state, validation, create/edit/delete modals, and toast notifications.
 */
export function useSegmentForm() {
	const { showToast } = useToast();

	// ─── Mutations ─────────────────────────────────────────────────────

	const { run: createSegment } = useBackendOperation(api.segments.create, {
		label: 'Create segment',
	});
	const { run: updateSegment } = useBackendOperation(api.segments.update, {
		label: 'Update segment',
	});
	const { run: deleteSegment } = useBackendOperation(api.segments.remove, {
		label: 'Delete segment',
	});

	// ─── Create/Edit Modal State ───────────────────────────────────────

	const isSegmentModalOpen = ref(false);
	const isEditMode = ref(false);
	const segmentForm = reactive({
		id: '' as Id<'segments'> | '',
		name: '',
		description: '',
		filters: {
			logic: 'AND' as FilterLogic,
			conditions: [] as FilterCondition[],
		},
	});
	const segmentErrors = reactive({
		name: '',
		conditions: '',
		general: '',
	});
	const isSaving = ref(false);

	// Dirty tracking for the unsaved-changes guard: snapshot the form when the
	// builder opens, then compare against it. Only meaningful while the modal is
	// open, so closing (which clears `isSegmentModalOpen`) reports clean.
	const formSnapshot = ref('');
	const serializeForm = () =>
		JSON.stringify({
			name: segmentForm.name,
			description: segmentForm.description,
			filters: segmentForm.filters,
		});
	const snapshotForm = () => {
		formSnapshot.value = serializeForm();
	};
	const isSegmentFormDirty = computed(
		() => isSegmentModalOpen.value && serializeForm() !== formSnapshot.value
	);

	// ─── Audience-Size Estimate (debounced, non-reactive) ──────────────
	// countMatchingContacts is an action (it walks the contacts table to count
	// matches), so we call it imperatively on a debounce when the builder is open
	// rather than subscribing reactively. The old reactive query re-ran on every
	// keystroke AND re-executed on every Contacts write (invalidation amplification).

	const matchingCount = ref<number | null>(null);
	const { run: estimateAudience, isLoading: countLoading } = useBackendOperation(
		api.segments.countMatchingContacts,
		{ label: 'Estimate audience size', type: 'action' }
	);
	let countTimer: ReturnType<typeof setTimeout> | null = null;
	// Monotonic token: the action resolves out of order (its duration varies with
	// filter selectivity), so only the latest request may commit its result.
	let countSeq = 0;

	watch(
		[() => segmentForm.filters, isSegmentModalOpen] as const,
		([filters, open]) => {
			if (countTimer) clearTimeout(countTimer);
			if (!open) {
				countSeq++; // invalidate any estimate launched before close
				matchingCount.value = null;
				return;
			}
			// Plain-object clone of the reactive filters for the action argument.
			const filtersArg = JSON.parse(JSON.stringify(filters)) as typeof segmentForm.filters;
			countTimer = setTimeout(async () => {
				const seq = ++countSeq;
				const result = await estimateAudience({ filters: filtersArg });
				if (seq === countSeq && isSegmentModalOpen.value) {
					matchingCount.value = result ?? null;
				}
			}, 400);
		},
		{ deep: true }
	);

	if (getCurrentInstance()) {
		onUnmounted(() => {
			if (countTimer) clearTimeout(countTimer);
		});
	}

	// ─── Modal Actions ─────────────────────────────────────────────────

	const resetErrors = () => {
		segmentErrors.name = '';
		segmentErrors.conditions = '';
		segmentErrors.general = '';
	};

	const openCreateModal = () => {
		isEditMode.value = false;
		segmentForm.id = '';
		segmentForm.name = '';
		segmentForm.description = '';
		segmentForm.filters = { logic: 'AND', conditions: [] };
		resetErrors();
		snapshotForm();
		isSegmentModalOpen.value = true;
	};

	const openEditModal = (segment: {
		_id: Id<'segments'>;
		name: string;
		description?: string;
		filters: SegmentFilters;
	}) => {
		isEditMode.value = true;
		segmentForm.id = segment._id;
		segmentForm.name = segment.name;
		segmentForm.description = segment.description || '';
		segmentForm.filters = segment.filters ?? { logic: 'AND', conditions: [] };
		resetErrors();
		snapshotForm();
		isSegmentModalOpen.value = true;
	};

	const closeSegmentModal = () => {
		isSegmentModalOpen.value = false;
	};

	// ─── Validation ────────────────────────────────────────────────────

	const validateForm = (): boolean => {
		resetErrors();

		if (!segmentForm.name.trim()) {
			segmentErrors.name = 'Segment name is required';
			return false;
		}

		if (segmentForm.filters.conditions.length === 0) {
			segmentErrors.conditions = 'At least one condition is required';
			return false;
		}

		for (let i = 0; i < segmentForm.filters.conditions.length; i++) {
			const condition = segmentForm.filters.conditions[i];
			if (!condition) continue;
			const module = conditionEditorModuleFor((condition as Condition).kind);
			const error = (module.validateForSubmit as (c: Condition) => string | null)(
				condition as Condition
			);
			if (error) {
				segmentErrors.conditions = `Condition ${i + 1}: ${error}`;
				return false;
			}
		}

		return true;
	};

	// ─── Save Handler ──────────────────────────────────────────────────

	const handleSave = async () => {
		if (!validateForm()) return;

		isSaving.value = true;

		if (isEditMode.value && segmentForm.id) {
			const result = await updateSegment({
				id: segmentForm.id as Id<'segments'>,
				name: segmentForm.name.trim(),
				description: segmentForm.description.trim() || undefined,
				filters: segmentForm.filters,
			});
			isSaving.value = false;
			if (result === undefined) return;
			showToast(`Segment "${segmentForm.name.trim()}" updated successfully`);
		} else {
			const result = await createSegment({
				name: segmentForm.name.trim(),
				description: segmentForm.description.trim() || undefined,
				filters: segmentForm.filters,
			});
			isSaving.value = false;
			if (result === undefined) return;
			showToast(`Segment "${segmentForm.name.trim()}" created successfully`);
		}

		closeSegmentModal();
	};

	// ─── Delete Modal State ────────────────────────────────────────────

	const isDeleteModalOpen = ref(false);
	const deleteTarget = ref<{
		id: Id<'segments'>;
		name: string;
	} | null>(null);
	const isDeleting = ref(false);

	const openDeleteModal = (segment: { _id: Id<'segments'>; name: string }) => {
		deleteTarget.value = {
			id: segment._id,
			name: segment.name,
		};
		isDeleteModalOpen.value = true;
	};

	const closeDeleteModal = () => {
		isDeleteModalOpen.value = false;
		deleteTarget.value = null;
	};

	const handleDelete = async () => {
		if (!deleteTarget.value) return;

		isDeleting.value = true;

		const result = await deleteSegment({ id: deleteTarget.value.id });
		isDeleting.value = false;
		if (result === undefined) return;
		showToast(`Segment "${deleteTarget.value.name}" deleted successfully`);
		closeDeleteModal();
	};

	return {
		// Create/Edit modal
		isSegmentModalOpen,
		isEditMode,
		segmentForm,
		segmentErrors,
		isSaving,
		isSegmentFormDirty,

		// Matching count
		matchingCount,
		countLoading,

		// Modal actions
		openCreateModal,
		openEditModal,
		closeSegmentModal,

		// Save
		handleSave,

		// Delete modal
		isDeleteModalOpen,
		deleteTarget,
		isDeleting,
		openDeleteModal,
		closeDeleteModal,
		handleDelete,
	};
}
