import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export type FormFieldType = 'email' | 'text' | 'checkbox';

export interface FormFieldDraft {
	key: string;
	label: string;
	type: FormFieldType;
	required: boolean;
}

interface FormEndpointRef {
	_id: Id<'formEndpoints'>;
	name: string;
	topicId?: Id<'topics'>;
	fields: FormFieldDraft[];
	redirectUrl?: string;
	honeypotFieldName?: string;
	isActive: boolean;
	doubleOptIn?: boolean;
}

/** Default fields a brand-new form starts with — mirrors the backend default. */
const defaultFields = (): FormFieldDraft[] => [
	{ key: 'email', label: 'Email', type: 'email', required: true },
];

interface FormToDelete {
	_id: Id<'formEndpoints'>;
	name: string;
	totalSubmissions: number;
}

/**
 * Composable for form endpoint settings page.
 * Manages CRUD operations, modal state, embed code generation, and clipboard actions.
 */
export function useFormSettings() {
	const { isLoading: organizationLoading } = useOrganizationContext();

	// DATA: Convex queries
	const { data: formsData, isLoading: formsLoading } = useOrganizationQuery(
		api.forms.endpoints.listByTeam
	);

	const { results: topicsData } = useTopicsList();

	const isLoading = computed(() => organizationLoading.value || formsLoading.value);

	// Mutations
	const { run: createForm } = useBackendOperation(api.forms.endpoints.create, {
		label: 'Create form endpoint',
	});
	const { run: updateForm } = useBackendOperation(api.forms.endpoints.update, {
		label: 'Update form endpoint',
	});
	const { run: removeForm } = useBackendOperation(api.forms.endpoints.remove, {
		label: 'Delete form endpoint',
	});

	// Convex site URL for embed code generation
	const runtimeConfig = useRuntimeConfig();
	const convexUrl = computed(() => {
		const url = runtimeConfig.public.convexSiteUrl || runtimeConfig.public.convexUrl;
		return url?.replace(/\/$/, '') || '';
	});

	// --- Toast notification (global) ---
	const { showToast: showNotification } = useToast();

	// --- Shared field-list editor ---
	// Both modals manage an ordered list of fields (key/label/type/required).
	// The editor mutates the supplied reactive array in place so the modal's
	// `fields` v-model and the create/update payload stay the same source.
	const makeFieldEditor = (fields: FormFieldDraft[]) => ({
		addField: () => {
			fields.push({ key: '', label: '', type: 'text', required: false });
		},
		removeField: (index: number) => {
			fields.splice(index, 1);
		},
		moveField: (index: number, direction: -1 | 1) => {
			const target = index + direction;
			if (target < 0 || target >= fields.length) return;
			const [moved] = fields.splice(index, 1);
			if (moved) fields.splice(target, 0, moved);
		},
	});

	// Trim/normalize fields and reject incomplete ones (blank key or label).
	// Returns null with an error message when a field is unusable.
	const normalizeFields = (
		fields: FormFieldDraft[]
	): { fields: FormFieldDraft[] } | { error: string } => {
		const cleaned: FormFieldDraft[] = [];
		const seen = new Set<string>();
		for (const field of fields) {
			const key = field.key.trim();
			const label = field.label.trim();
			if (!key || !label) {
				return { error: 'Every field needs a key and a label' };
			}
			if (seen.has(key)) {
				return { error: `Duplicate field key "${key}"` };
			}
			seen.add(key);
			cleaned.push({ key, label, type: field.type, required: field.required });
		}
		if (cleaned.length === 0) {
			return { error: 'Add at least one field' };
		}
		// A form whose submissions can never resolve an address is dead on
		// arrival — forms/submission.ts rejects every POST with 'Email is
		// required'. Keep the editor's own "email is required" copy honest.
		if (!cleaned.some((f) => f.type === 'email')) {
			return { error: 'A form needs at least one email field' };
		}
		return { fields: cleaned };
	};

	// --- Add form modal ---
	const isAddModalOpen = ref(false);
	const addForm = reactive({
		name: '',
		topicId: '' as string,
		redirectUrl: '',
		honeypotFieldName: '',
		doubleOptIn: false,
		fields: defaultFields(),
	});
	const addFormErrors = reactive({ name: '', fields: '' });
	const isAdding = ref(false);
	const addFieldEditor = makeFieldEditor(addForm.fields);

	const resetAddForm = () => {
		addForm.name = '';
		addForm.topicId = '';
		addForm.redirectUrl = '';
		addForm.honeypotFieldName = '';
		addForm.doubleOptIn = false;
		addForm.fields.splice(0, addForm.fields.length, ...defaultFields());
		addFormErrors.name = '';
		addFormErrors.fields = '';
	};

	const validateAddForm = (): boolean => {
		addFormErrors.name = '';
		addFormErrors.fields = '';
		if (!addForm.name.trim()) {
			addFormErrors.name = 'Form name is required';
			return false;
		}
		const result = normalizeFields(addForm.fields);
		if ('error' in result) {
			addFormErrors.fields = result.error;
			return false;
		}
		return true;
	};

	const handleAddForm = async () => {
		if (!validateAddForm()) return;
		const normalized = normalizeFields(addForm.fields);
		if ('error' in normalized) {
			addFormErrors.fields = normalized.error;
			return;
		}

		isAdding.value = true;
		const result = await createForm({
			name: addForm.name.trim(),
			topicId: addForm.topicId
				? (addForm.topicId as Id<'topics'>)
				: undefined,
			fields: normalized.fields,
			redirectUrl: addForm.redirectUrl.trim() || undefined,
			honeypotFieldName: addForm.honeypotFieldName.trim() || undefined,
			doubleOptIn: addForm.doubleOptIn || undefined,
		});
		isAdding.value = false;
		if (result === undefined) return;
		showNotification('Form endpoint created successfully');
		isAddModalOpen.value = false;
		resetAddForm();
	};

	// --- Edit form modal ---
	const formToEdit = ref<FormEndpointRef | null>(null);
	const editForm = reactive({
		name: '',
		topicId: '' as string,
		redirectUrl: '',
		honeypotFieldName: '',
		doubleOptIn: false,
		fields: defaultFields(),
	});
	const editFormErrors = reactive({ name: '', fields: '' });
	const isSaving = ref(false);
	const editFieldEditor = makeFieldEditor(editForm.fields);

	const openEditModal = (form: FormEndpointRef | null) => {
		if (!form) return;
		formToEdit.value = form;
		editForm.name = form.name;
		editForm.topicId = form.topicId || '';
		editForm.redirectUrl = form.redirectUrl || '';
		editForm.honeypotFieldName = form.honeypotFieldName || '';
		editForm.doubleOptIn = form.doubleOptIn || false;
		// Clone so edits don't mutate the live query result before saving.
		const loaded = (form.fields?.length ? form.fields : defaultFields()).map((f) => ({
			...f,
		}));
		editForm.fields.splice(0, editForm.fields.length, ...loaded);
		editFormErrors.name = '';
		editFormErrors.fields = '';
	};

	const validateEditForm = (): boolean => {
		editFormErrors.name = '';
		editFormErrors.fields = '';
		if (!editForm.name.trim()) {
			editFormErrors.name = 'Form name is required';
			return false;
		}
		const result = normalizeFields(editForm.fields);
		if ('error' in result) {
			editFormErrors.fields = result.error;
			return false;
		}
		return true;
	};

	const handleSaveEdit = async () => {
		if (!formToEdit.value) return;
		if (!validateEditForm()) return;
		const normalized = normalizeFields(editForm.fields);
		if ('error' in normalized) {
			editFormErrors.fields = normalized.error;
			return;
		}

		isSaving.value = true;
		const result = await updateForm({
			formEndpointId: formToEdit.value._id,
			name: editForm.name.trim(),
			topicId: editForm.topicId
				? (editForm.topicId as Id<'topics'>)
				: undefined,
			fields: normalized.fields,
			redirectUrl: editForm.redirectUrl.trim() || undefined,
			honeypotFieldName: editForm.honeypotFieldName.trim() || undefined,
			doubleOptIn: editForm.doubleOptIn,
		});
		isSaving.value = false;
		if (result === undefined) return;
		showNotification('Form endpoint updated successfully');
		formToEdit.value = null;
	};

	// --- Toggle active status ---
	const handleToggleActive = async (form: {
		_id: Id<'formEndpoints'>;
		isActive: boolean;
		name: string;
	}) => {
		const result = await updateForm({
			formEndpointId: form._id,
			isActive: !form.isActive,
		});
		if (result === undefined) return;
		showNotification(`Form "${form.name}" ${form.isActive ? 'disabled' : 'enabled'}`);
	};

	// --- Delete form modal ---
	const formToDelete = ref<FormToDelete | null>(null);
	const isDeleting = ref(false);

	const handleDeleteForm = async () => {
		if (!formToDelete.value) return;

		isDeleting.value = true;
		const result = await removeForm({
			formEndpointId: formToDelete.value._id,
		});
		isDeleting.value = false;
		if (result === undefined) return;
		showNotification('Form endpoint deleted successfully');
		formToDelete.value = null;
	};

	// --- Expansion / embed code ---
	const expandedFormId = ref<Id<'formEndpoints'> | null>(null);
	const { copy, copiedKey } = useCopyToClipboard();
	const copiedCode = computed(() => copiedKey.value as string | null);

	const toggleFormExpansion = (formId: Id<'formEndpoints'>) => {
		expandedFormId.value = expandedFormId.value === formId ? null : formId;
	};

	const getFormUrl = (formId: Id<'formEndpoints'>) => {
		return `${convexUrl.value}/forms/${formId}`;
	};

	const getEmbedCode = (form: {
		_id: Id<'formEndpoints'>;
		name: string;
		fields: Array<{ key: string; label: string; type: string; required: boolean }>;
		honeypotFieldName?: string;
	}) => {
		const formUrl = getFormUrl(form._id);
		const fields = form.fields ?? [{ key: 'email', label: 'Email', type: 'email', required: true }];

		const fieldHtml = fields
			.map((field) => {
				if (field.type === 'checkbox') {
					return `  <label>
    <input type="checkbox" name="${field.key}"${field.required ? ' required' : ''}>
    ${field.label}
  </label>`;
				}
				return `  <label>
    ${field.label}${field.required ? ' *' : ''}
    <input type="${field.type}" name="${field.key}" placeholder="${field.label}"${field.required ? ' required' : ''}>
  </label>`;
			})
			.join('\n');

		const honeypotHtml = form.honeypotFieldName
			? `\n  <!-- Honeypot field for spam prevention (keep hidden) -->\n  <input type="text" name="${form.honeypotFieldName}" style="display:none" tabindex="-1" autocomplete="off">`
			: '';

		return `<form action="${formUrl}" method="POST">
${fieldHtml}${honeypotHtml}
  <button type="submit">Subscribe</button>
</form>`;
	};

	const copyToClipboard = async (text: string, codeType: string) => {
		const ok = await copy(text, codeType);
		if (!ok) {
			showNotification('Failed to copy to clipboard', 'error');
		}
	};

	// --- Helpers ---
	const getTopicName = (topicId?: Id<'topics'>) => {
		if (!topicId || !topicsData.value) return 'None';
		const list = topicsData.value.find((l) => l._id === topicId);
		return list?.name || 'Unknown';
	};

	return {
		// Data
		formsData,
		topicsData,
		isLoading,

		// Add form
		isAddModalOpen,
		addForm,
		addFormErrors,
		isAdding,
		resetAddForm,
		handleAddForm,
		addFieldEditor,

		// Edit form
		formToEdit,
		editForm,
		editFormErrors,
		isSaving,
		openEditModal,
		handleSaveEdit,
		editFieldEditor,

		// Toggle active
		handleToggleActive,

		// Delete form
		formToDelete,
		isDeleting,
		handleDeleteForm,

		// Expansion / embed
		expandedFormId,
		copiedCode,
		toggleFormExpansion,
		getFormUrl,
		getEmbedCode,
		copyToClipboard,

		// Helpers
		getTopicName,
		formatDate,
	};
}
