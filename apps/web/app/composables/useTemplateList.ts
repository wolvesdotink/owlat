import { computed, ref, type Ref } from 'vue';
import { useListPage } from './useListPage';
import {
	TEMPLATE_SORT_OPTIONS,
	type TemplateSortOption,
	type TemplateStatus,
} from '~/utils/templateListSort';

/** What the shared template grid, table and card list read off a row. */
export interface TemplateListItem {
	_id: string;
	name: string;
	subject?: string;
	status: TemplateStatus;
	createdAt: number;
	updatedAt: number;
}

/**
 * A page-specific row action (transactional's "View API code"). The shared
 * rows put it in the overflow menu, and also on the grid card's hover overlay
 * (`overlay`) and in the table's action cell (`inline`) when asked to.
 */
export interface TemplateRowAction<T> {
	key: string;
	icon: string;
	/** Already resolved — the page builds these where `t()` is at hand. */
	label: string;
	overlay?: boolean;
	inline?: boolean;
	run: (item: T) => void;
}

interface TemplateListQuery<T> {
	rows: Ref<readonly T[] | undefined>;
	isLoading: Ref<boolean>;
	error: Ref<Error | null>;
	refetch: () => void;
}

interface UseTemplateListOptions<T extends TemplateListItem> {
	/**
	 * Build the page's query from the list state. The two lists differ here on
	 * purpose: marketing sorts the loaded page client-side, transactional passes
	 * the sort to its query.
	 */
	query: (state: {
		search: Readonly<Ref<string>>;
		sort: Readonly<Ref<TemplateSortOption>>;
	}) => TemplateListQuery<T>;
	sortOptions?: readonly TemplateSortOption[];
	/** Where a row opens. */
	editPath: (item: T) => string;
	/** Resolve `false` when the delete failed, so the dialog stays open. */
	onDelete: (item: T) => Promise<boolean>;
	onDuplicate: (item: T) => Promise<void>;
	/** The `n` shortcut's target — the page's create flow. */
	onNew: () => void;
	canCreate: () => boolean;
	isBusy?: () => boolean;
	onEscape?: () => boolean;
	defaultViewMode?: 'grid' | 'list';
}

/**
 * List state for the marketing and transactional template pages: `useListPage`
 * (search, sort, delete dialog, shortcuts) plus the parts only template lists
 * share — the grid/list view mode, opening a row, and the loading/empty flags
 * `ListPageShell` renders from.
 */
export function useTemplateList<T extends TemplateListItem>(options: UseTemplateListOptions<T>) {
	const router = useRouter();
	const { hasActiveOrganization, isLoading: organizationLoading } = useOrganizationContext();

	const list = useListPage<TemplateSortOption, T>({
		sortOptions: options.sortOptions ?? TEMPLATE_SORT_OPTIONS,
		onDelete: options.onDelete,
		onNew: options.onNew,
		canCreate: options.canCreate,
		isBusy: options.isBusy,
		onEscape: options.onEscape,
	});

	const query = options.query({ search: list.debouncedSearch, sort: list.currentSort });
	const items = computed<readonly T[]>(() => query.rows.value ?? []);

	const viewMode = ref<'grid' | 'list'>(options.defaultViewMode ?? 'list');

	/**
	 * First load only: once rows are on screen a refetch keeps showing them.
	 * Without an organization the query is skipped and would read as loading
	 * forever, so that case falls through to the shell's no-organization state.
	 */
	const isLoading = computed(
		() =>
			(organizationLoading.value || (hasActiveOrganization.value && query.isLoading.value)) &&
			items.value.length === 0
	);

	const handleEdit = (item: T) => router.push(options.editPath(item));

	return {
		...list,
		items,
		isEmpty: computed(() => items.value.length === 0),
		isLoading,
		error: query.error,
		refetch: query.refetch,
		hasOrganization: hasActiveOrganization,
		viewMode,
		handleEdit,
		handleDuplicate: options.onDuplicate,
	};
}
