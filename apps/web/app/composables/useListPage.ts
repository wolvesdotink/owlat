import { computed, onMounted, onUnmounted, ref, toValue, type MaybeRefOrGetter } from 'vue';
import { useDebouncedSearch } from './useDebouncedSearch';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { useConfirmModal } from './useModal';

/** The shape `ListSortMenu` renders: a value and an i18n message key. */
export interface ListSortOption {
	value: string;
	/** i18n message key, resolved with `t()` where the menu renders. */
	label: string;
}

export interface UseListPageOptions<TSort extends ListSortOption, TItem> {
	sortOptions: readonly TSort[];
	/** The sort a fresh visit opens on; the first option when omitted. */
	defaultSort?: TSort['value'];
	/**
	 * Run the delete the confirmation dialog asked for. Resolve `false` when it
	 * failed (the operation already surfaced why): the dialog then stays open
	 * so the user can retry or cancel.
	 */
	onDelete: (item: TItem) => Promise<boolean | void>;
	/** What the `n` shortcut does — usually opens the page's create flow. */
	onNew?: () => void;
	/** Whether `n` may fire at all (the same permission the New button carries). */
	canCreate?: MaybeRefOrGetter<boolean>;
	/** True while another overlay owns the page (a create modal): `n` stays inert. */
	isBusy?: MaybeRefOrGetter<boolean>;
	/**
	 * First refusal on Escape, for the page's own overlays. Return `true` when it
	 * handled the key; otherwise Escape closes the delete dialog when it is idle.
	 */
	onEscape?: () => boolean;
	/** Search debounce, in ms. */
	searchDelay?: number;
}

/**
 * The state every dashboard list page repeats: a debounced search, the current
 * sort, the delete-confirmation dialog, and the `n` / Escape shortcuts.
 *
 * `ListPageShell` renders it; this owns it. Search clears through the debounced
 * composable's own `clear()` — writing `debouncedSearch` from a page hits a
 * readonly ref and only lands once the debounce fires.
 */
export function useListPage<TSort extends ListSortOption, TItem>(
	options: UseListPageOptions<TSort, TItem>
) {
	const {
		searchQuery,
		debouncedSearch,
		clear: clearSearch,
	} = useDebouncedSearch(options.searchDelay ?? 300);

	// --- Sort ---

	const initialSort =
		options.sortOptions.find((option) => option.value === options.defaultSort) ??
		options.sortOptions[0];
	if (!initialSort) throw new Error('useListPage needs at least one sort option');
	const sortValue = ref<string>(initialSort.value);
	const currentSort = computed<TSort>(
		() => options.sortOptions.find((option) => option.value === sortValue.value) ?? initialSort
	);
	const selectSort = (value: string) => {
		if (options.sortOptions.some((option) => option.value === value)) sortValue.value = value;
	};

	// --- Delete confirmation ---

	const deleteModal = useConfirmModal<TItem>();
	const deleteTarget = computed(() => deleteModal.data.value);
	const isDeleteOpen = computed(() => deleteModal.isOpen.value);
	const isDeleting = computed(() => deleteModal.isLoading.value);

	const openDelete = (item: TItem) => deleteModal.open(item);

	const dismissDelete = () => {
		deleteModal.close();
		deleteModal.data.value = null;
	};

	/** Cancel/backdrop/Escape: ignored while the delete is in flight. */
	const closeDelete = () => {
		if (!isDeleting.value) dismissDelete();
	};

	const confirmDelete = async () => {
		const target = deleteModal.data.value;
		if (target === null || isDeleting.value) return;
		deleteModal.setLoading(true);
		try {
			const outcome = await options.onDelete(target);
			if (outcome !== false) dismissDelete();
		} finally {
			deleteModal.setLoading(false);
		}
	};

	// --- Shortcuts ---

	const { registerNewShortcut, registerEscapeHandler, unregisterShortcut } = useKeyboardShortcuts();

	onMounted(() => {
		const onNew = options.onNew;
		if (onNew) {
			registerNewShortcut(() => {
				if (!toValue(options.canCreate ?? true)) return;
				if (toValue(options.isBusy ?? false) || isDeleteOpen.value) return;
				onNew();
			});
		}
		registerEscapeHandler(() => {
			if (options.onEscape?.()) return;
			if (isDeleteOpen.value) closeDelete();
		});
	});

	onUnmounted(() => {
		unregisterShortcut('global.newItem');
		unregisterShortcut('global.close');
	});

	return {
		searchQuery,
		debouncedSearch,
		clearSearch,
		sortOptions: options.sortOptions,
		currentSort,
		selectSort,
		deleteTarget,
		isDeleteOpen,
		isDeleting,
		openDelete,
		closeDelete,
		confirmDelete,
	};
}
