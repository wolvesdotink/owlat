<script setup lang="ts">
/**
 * The frame of a dashboard list page: header, toolbar, the three empty states,
 * the grid / table / mobile-card switch and the delete confirmation.
 *
 * Presentational only. The page owns its data and its state (`useListPage`
 * holds search, sort and the delete dialog) and hands the rows in through the
 * `#grid`, `#table` and `#cards` slots. Before this, each list page assembled
 * the same frame by copying its nearest neighbour, and every fix — the mobile
 * card list, the listbox semantics, the shortcuts — landed on one copy only.
 * `#before-header` takes a section's tab bar and `#loading` a content-shaped
 * skeleton in place of the default spinner. `#delete-extra` adds a line under
 * the delete dialog's description (the blocks list warns how many emails use
 * the block). `deleteBlocked` refuses the delete outright — the confirm button
 * stays disabled, and `#delete-extra` says why (an active automation must be
 * paused first).
 *
 * `layout="grid"` is for a list with no table view (saved blocks): `#grid`
 * always renders and there is no grid/list toggle.
 *
 * Below `md` the table's columns cannot fit, so `#cards` renders instead of
 * `#table`. Exactly one of the two is mounted (`useDataTableViewport`): the app
 * runs with `ssr: false`, so the first value is already the real one, and a
 * CSS-only switch would double the row DOM and every row's overflow menu. A
 * list whose rows fit any width (the campaigns list) passes only `#cards`, and
 * it renders at every width.
 */
import type { ListSortOption } from '~/composables/useListPage';

type ViewMode = 'grid' | 'list';

interface EmptyCopy {
	icon: string;
	/** Optional line above the title (an all-clear state, not a missing one). */
	eyebrow?: string;
	title: string;
	description: string;
}

interface DeleteCopy {
	title: string;
	/** i18n key of the question; its `{name}` placeholder gets the item's name in bold. */
	confirmKeypath: string;
	description: string;
	confirmText: string;
}

const props = withDefaults(
	defineProps<{
		title: string;
		description?: string;
		/** First load in flight: the query boundary shows its spinner. */
		loading: boolean;
		/**
		 * The list query's `error`. Required: a list that drops it renders a failed
		 * read as an empty list (#721).
		 */
		error: Error | null;
		errorTitle: string;
		/** Label under the default spinner; unused when the page passes `#loading`. */
		loadingLabel?: string;
		hasOrganization: boolean;
		/** The query resolved to no rows. */
		isEmpty: boolean;
		/** The raw search input (`v-model:search`). */
		search: string;
		/** The search term the rows reflect — the debounced one. */
		activeSearch: string;
		searchPlaceholder: string;
		sortOptions?: readonly ListSortOption[];
		/** Selected sort `value` (`v-model:sort`). */
		sort?: string;
		sortLabel?: string;
		sortListboxId?: string;
		/** `v-model:viewMode`. Leave unset for a page without a grid view. */
		viewMode?: ViewMode;
		/**
		 * `table` (default): `#table`, or `#cards` below `md`, with `#grid` when
		 * `viewMode` asks for it. `grid`: `#grid` only, and no view toggle.
		 */
		layout?: 'table' | 'grid';
		emptyNoOrg: EmptyCopy;
		empty: EmptyCopy;
		noResults: { title: string; description: string };
		deleteCopy: DeleteCopy;
		deleteOpen: boolean;
		/** Name of the item the delete dialog is about. */
		deleteName?: string;
		isDeleting: boolean;
		/** The item cannot be deleted as it stands: confirm stays disabled. */
		deleteBlocked?: boolean;
	}>(),
	{
		description: undefined,
		loadingLabel: undefined,
		sortOptions: undefined,
		sort: undefined,
		sortLabel: undefined,
		sortListboxId: undefined,
		viewMode: undefined,
		layout: 'table',
		deleteName: '',
		deleteBlocked: false,
	}
);

const emit = defineEmits<{
	'update:search': [value: string];
	'update:sort': [value: string];
	'update:viewMode': [value: ViewMode];
	retry: [];
	'clear-search': [];
	'confirm-delete': [];
	'cancel-delete': [];
}>();

const { t } = useI18n();

const tableFits = useDataTableViewport();

const viewModeOptions = computed(() => [
	{ value: 'grid', label: t('shared.listPage.gridView') },
	{ value: 'list', label: t('shared.listPage.listView') },
]);

const showEmpty = computed(() => !props.loading && props.isEmpty && !props.activeSearch);
const showNoResults = computed(() => !props.loading && props.isEmpty && !!props.activeSearch);
const showGrid = computed(() => props.layout === 'grid' || props.viewMode === 'grid');

const onDeleteOpenChange = (open: boolean) => {
	if (!open) emit('cancel-delete');
};
</script>

<template>
	<div class="p-6 lg:p-8">
		<slot name="before-header" />
		<UiPageHeader :title="title" :description="description" class="mb-6">
			<template v-if="$slots['actions']" #actions>
				<slot name="actions" />
			</template>
		</UiPageHeader>

		<div class="flex flex-col sm:flex-row sm:items-center gap-4 mb-6">
			<slot name="filters" />

			<div class="flex-1" />

			<div class="flex flex-wrap items-center gap-3">
				<UiInput
					:model-value="search"
					type="text"
					:placeholder="searchPlaceholder"
					size="sm"
					class="w-64"
					@update:model-value="emit('update:search', String($event ?? ''))"
				>
					<template #iconLeft>
						<Icon name="lucide:search" class="w-4 h-4 text-text-tertiary" />
					</template>
				</UiInput>

				<ListSortMenu
					v-if="sortOptions && sort !== undefined && sortLabel && sortListboxId"
					:options="sortOptions"
					:model-value="sort"
					:label="sortLabel"
					:listbox-id="sortListboxId"
					@update:model-value="emit('update:sort', $event)"
				/>

				<UiSegmentedControl
					v-if="viewMode && layout === 'table'"
					:options="viewModeOptions"
					:model-value="viewMode"
					size="sm"
					:aria-label="t('shared.listPage.viewMode')"
					@update:model-value="emit('update:viewMode', $event as ViewMode)"
				>
					<!-- Icon-only segments: the option label stays the accessible name. -->
					<template #option-grid="{ option }">
						<Icon name="lucide:grid-3x3" class="w-4 h-4" />
						<span class="sr-only">{{ option.label }}</span>
					</template>
					<template #option-list="{ option }">
						<Icon name="lucide:list" class="w-4 h-4" />
						<span class="sr-only">{{ option.label }}</span>
					</template>
				</UiSegmentedControl>
			</div>
		</div>

		<UiQueryBoundary
			:loading="loading"
			:error="error"
			:error-title="errorTitle"
			:loading-label="loadingLabel"
			@retry="emit('retry')"
		>
			<template v-if="$slots['loading']" #loading>
				<slot name="loading" />
			</template>

			<UiEmptyState
				v-if="!hasOrganization"
				:icon="emptyNoOrg.icon"
				:title="emptyNoOrg.title"
				:description="emptyNoOrg.description"
			/>

			<UiEmptyState
				v-else-if="showEmpty"
				:icon="empty.icon"
				:eyebrow="empty.eyebrow"
				:title="empty.title"
				:description="empty.description"
			>
				<template v-if="$slots['empty-action']" #action>
					<slot name="empty-action" />
				</template>
			</UiEmptyState>

			<UiEmptyState
				v-else-if="showNoResults"
				variant="no-results"
				icon="lucide:search"
				:title="noResults.title"
				:description="noResults.description"
				:clear-label="t('shared.listPage.clearSearch')"
				@clear="emit('clear-search')"
			/>

			<slot v-else-if="showGrid" name="grid" />

			<UiCard v-else padding="none" overflow="hidden">
				<slot v-if="tableFits && $slots['table']" name="table" />
				<slot v-else name="cards" />
			</UiCard>
		</UiQueryBoundary>

		<slot />

		<UiConfirmationDialog
			:open="deleteOpen"
			variant="danger"
			:title="deleteCopy.title"
			:confirm-text="deleteCopy.confirmText"
			:is-loading="isDeleting"
			:confirm-disabled="deleteBlocked"
			@update:open="onDeleteOpenChange"
			@confirm="emit('confirm-delete')"
		>
			<template #description>
				<I18nT
					:keypath="deleteCopy.confirmKeypath"
					tag="p"
					class="text-text-primary"
					scope="global"
				>
					<template #name>
						<span class="font-semibold">"{{ deleteName }}"</span>
					</template>
				</I18nT>
				<p class="text-sm text-text-secondary mt-2">{{ deleteCopy.description }}</p>
				<slot name="delete-extra" />
			</template>
		</UiConfirmationDialog>
	</div>
</template>
