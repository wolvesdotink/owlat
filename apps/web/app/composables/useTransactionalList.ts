import { api } from '@owlat/api';
import { toSlug } from '@owlat/shared';
import type { Id } from '@owlat/api/dataModel';

// Types
export type StatusFilter = 'all' | 'draft' | 'published' | 'pending_review';

export type SortOption = {
	label: string;
	value: string;
	sortBy: 'updatedAt' | 'createdAt' | 'name';
	sortOrder: 'asc' | 'desc';
};

export const SORT_OPTIONS: SortOption[] = [
	{ label: 'Last modified', value: 'updatedAt-desc', sortBy: 'updatedAt', sortOrder: 'desc' },
	{ label: 'Oldest modified', value: 'updatedAt-asc', sortBy: 'updatedAt', sortOrder: 'asc' },
	{ label: 'Newest created', value: 'createdAt-desc', sortBy: 'createdAt', sortOrder: 'desc' },
	{ label: 'Oldest created', value: 'createdAt-asc', sortBy: 'createdAt', sortOrder: 'asc' },
	{ label: 'Name (A-Z)', value: 'name-asc', sortBy: 'name', sortOrder: 'asc' },
	{ label: 'Name (Z-A)', value: 'name-desc', sortBy: 'name', sortOrder: 'desc' },
];

export const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
	{ value: 'all', label: 'All' },
	{ value: 'draft', label: 'Draft' },
	{ value: 'published', label: 'Published' },
	{ value: 'pending_review', label: 'Pending Review' },
];

/**
 * Composable for transactional email list management.
 * Handles filtering, sorting, search, CRUD operations, and code snippet display.
 */
type SnippetLanguage = 'curl' | 'javascript' | 'python';

export function useTransactionalList() {
	const router = useRouter();
	const { copy, copiedKey, reset: resetCopiedSnippet } = useCopyToClipboard();

	// --- FILTER / SEARCH / SORT STATE ---

	const selectedStatus = ref<StatusFilter>('all');
	const viewMode = ref<'grid' | 'list'>('list');
	// Debounce via the shared composable (also clears its timer on unmount).
	const { searchQuery, debouncedSearch } = useDebouncedSearch(300);
	const currentSort = ref<SortOption>(SORT_OPTIONS[0]!);
	const isSortDropdownOpen = ref(false);

	const selectSort = (option: SortOption) => {
		currentSort.value = option;
		isSortDropdownOpen.value = false;
	};

	const handleSortClickOutside = (event: MouseEvent) => {
		const target = event.target as HTMLElement;
		if (!target.closest('[data-sort-dropdown]')) {
			isSortDropdownOpen.value = false;
		}
	};

	onMounted(() => {
		document.addEventListener('click', handleSortClickOutside);
	});

	onUnmounted(() => {
		document.removeEventListener('click', handleSortClickOutside);
	});

	// --- DATA QUERIES ---

	const {
		data: transactionalEmails,
		isLoading: emailsLoading,
		error: emailsError,
	} = useOrganizationQuery(api.transactional.emails.list, () => ({
		status: selectedStatus.value === 'all' ? undefined : selectedStatus.value,
		search: debouncedSearch.value || undefined,
		sortBy: currentSort.value.sortBy,
		sortOrder: currentSort.value.sortOrder,
	}));

	const { data: statusCounts } = useOrganizationQuery(api.transactional.emails.countByStatus);
	const { data: sendCounts } = useOrganizationQuery(api.transactional.sends.getCounts);

	const isLoading = computed(() => emailsLoading.value);

	// --- TOAST NOTIFICATION ---

	const { showToast: showNotification } = useToast();

	// --- CREATE FORM ERROR (bound inline in the create modal) ---

	const createError = ref<string | null>('');

	// --- MUTATIONS ---

	const { run: duplicateEmail } = useBackendOperation(api.transactional.emails.duplicate, {
		label: 'Duplicate transactional email',
	});
	const { run: deleteEmail } = useBackendOperation(api.transactional.emails.remove, {
		label: 'Delete transactional email',
	});
	const { run: createEmail } = useBackendOperation(api.transactional.emails.create, {
		label: 'Create transactional email',
		inlineTarget: createError,
	});

	// --- ACTION DROPDOWN STATE ---

	const dropdownOpenStates = reactive<Record<string, boolean>>({});

	// --- UTILITIES ---

	const getStatusBadge = (status: 'draft' | 'published' | 'pending_review') => {
		if (status === 'published') {
			return {
				color: 'bg-success/10 text-success',
				icon: 'lucide:check-circle',
				label: 'Published',
			};
		}

		if (status === 'pending_review') {
			return {
				color: 'bg-warning/10 text-warning',
				icon: 'lucide:clock-3',
				label: 'Pending Review',
			};
		}

		return {
			color: 'bg-text-tertiary/10 text-text-tertiary',
			icon: 'lucide:file-text',
			label: 'Draft',
		};
	};

	// --- DUPLICATE HANDLER ---

	const handleDuplicate = async (emailId: Id<'transactionalEmails'>) => {
		const result = await duplicateEmail({ id: emailId });
		if (result === undefined) return;
		showNotification('Transactional email duplicated successfully');
	};

	// --- DELETE MODAL ---

	const isDeleteModalOpen = ref(false);
	const emailToDelete = ref<{ id: Id<'transactionalEmails'>; name: string } | null>(null);
	const isDeleting = ref(false);

	const openDeleteModal = (id: Id<'transactionalEmails'>, name: string) => {
		emailToDelete.value = { id, name };
		isDeleteModalOpen.value = true;
	};

	const closeDeleteModal = () => {
		isDeleteModalOpen.value = false;
		emailToDelete.value = null;
	};

	const handleDelete = async () => {
		if (!emailToDelete.value) return;

		isDeleting.value = true;
		const result = await deleteEmail({ id: emailToDelete.value.id });
		isDeleting.value = false;
		if (result === undefined) return;
		showNotification('Transactional email deleted successfully');
		closeDeleteModal();
	};

	// --- CREATE MODAL ---

	const isCreateModalOpen = ref(false);
	// `defaultLanguage` is captured at create time because a brand-new email has no
	// translations yet — there is nothing to re-key — so a plain field on
	// `create` is correct (the content-swapping `setDefaultLanguage` path that
	// marketing needs only applies once overlays exist). Without this the backend
	// default of 'en' was unavoidable for any dashboard-authored email.
	const createForm = reactive({ name: '', slug: '', defaultLanguage: 'en' });
	const createFormErrors = reactive({ name: '', slug: '' });
	const isCreating = ref(false);

	watch(
		() => createForm.name,
		(name) => {
			if (!createForm.slug || createForm.slug === toSlug(createForm.name.slice(0, -1))) {
				createForm.slug = toSlug(name);
			}
		}
	);

	const openCreateModal = () => {
		createForm.name = '';
		createForm.slug = '';
		createForm.defaultLanguage = 'en';
		createFormErrors.name = '';
		createFormErrors.slug = '';
		createError.value = '';
		isCreateModalOpen.value = true;
	};

	const closeCreateModal = () => {
		isCreateModalOpen.value = false;
	};

	const validateSlug = (slug: string): boolean => {
		const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
		return slugRegex.test(slug);
	};

	const handleCreate = async () => {
		createFormErrors.name = '';
		createFormErrors.slug = '';
		createError.value = '';

		let hasErrors = false;
		if (!createForm.name.trim()) {
			createFormErrors.name = 'Name is required';
			hasErrors = true;
		}
		if (!createForm.slug.trim()) {
			createFormErrors.slug = 'Slug is required';
			hasErrors = true;
		} else if (!validateSlug(createForm.slug)) {
			createFormErrors.slug =
				"Slug must be lowercase alphanumeric with hyphens (e.g., 'welcome-email')";
			hasErrors = true;
		}

		if (hasErrors) return;

		isCreating.value = true;

		const emailId = await createEmail({
			name: createForm.name.trim(),
			slug: createForm.slug.trim(),
			defaultLanguage: createForm.defaultLanguage,
		});
		isCreating.value = false;
		if (emailId === undefined) return;

		closeCreateModal();
		router.push(`/dashboard/send/transactional/${emailId}/edit`);
	};

	// --- NAVIGATION ---

	const handleEdit = (emailId: Id<'transactionalEmails'>) => {
		router.push(`/dashboard/send/transactional/${emailId}/edit`);
	};

	// --- CODE SNIPPET MODAL ---

	const isCodeSnippetModalOpen = ref(false);
	const selectedEmailForCode = ref<{
		id: Id<'transactionalEmails'>;
		name: string;
		slug: string;
	} | null>(null);
	const copiedSnippet = computed(() => copiedKey.value as SnippetLanguage | null);

	const openCodeSnippetModal = (id: Id<'transactionalEmails'>, name: string, slug: string) => {
		selectedEmailForCode.value = { id, name, slug };
		isCodeSnippetModalOpen.value = true;
		resetCopiedSnippet();
	};

	const closeCodeSnippetModal = () => {
		isCodeSnippetModalOpen.value = false;
		selectedEmailForCode.value = null;
		resetCopiedSnippet();
	};

	const getCodeSnippet = (language: 'curl' | 'javascript' | 'python'): string => {
		if (!selectedEmailForCode.value) return '';
		const slug = selectedEmailForCode.value.slug;

		switch (language) {
			case 'curl':
				return `curl -X POST https://api.owlat.app/api/v1/transactional \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "slug": "${slug}",
    "email": "user@example.com",
    "dataVariables": {
      "name": "John",
      "orderNumber": "12345"
    }
  }'`;
			case 'javascript':
				return `const response = await fetch('https://api.owlat.app/api/v1/transactional', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_API_KEY',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    slug: '${slug}',
    email: 'user@example.com',
    dataVariables: {
      name: 'John',
      orderNumber: '12345',
    },
  }),
});

const result = await response.json();`;
			case 'python':
				return `import requests

response = requests.post(
    'https://api.owlat.app/api/v1/transactional',
    headers={
        'Authorization': 'Bearer YOUR_API_KEY',
        'Content-Type': 'application/json',
    },
    json={
        'slug': '${slug}',
        'email': 'user@example.com',
        'dataVariables': {
            'name': 'John',
            'orderNumber': '12345',
        },
    },
)

result = response.json()`;
		}
	};

	const copyToClipboard = async (language: 'curl' | 'javascript' | 'python') => {
		const snippet = getCodeSnippet(language);
		await copy(snippet, language);
	};

	return {
		// Filter / search / sort
		selectedStatus,
		viewMode,
		searchQuery,
		debouncedSearch,
		currentSort,
		isSortDropdownOpen,
		selectSort,
		statusFilters: STATUS_FILTERS,
		sortOptions: SORT_OPTIONS,

		// Data
		transactionalEmails,
		statusCounts,
		sendCounts,
		isLoading,
		error: emailsError,

		// Dropdown state
		dropdownOpenStates,

		// Utilities
		formatDate,
		getStatusBadge,

		// Duplicate
		handleDuplicate,

		// Delete modal
		isDeleteModalOpen,
		emailToDelete,
		isDeleting,
		openDeleteModal,
		closeDeleteModal,
		handleDelete,

		// Create modal
		isCreateModalOpen,
		createForm,
		createFormErrors,
		createError,
		isCreating,
		openCreateModal,
		closeCreateModal,
		handleCreate,

		// Navigation
		handleEdit,

		// Code snippet modal
		isCodeSnippetModalOpen,
		selectedEmailForCode,
		copiedSnippet,
		openCodeSnippetModal,
		closeCodeSnippetModal,
		getCodeSnippet,
		copyToClipboard,
	};
}
