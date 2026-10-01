<script setup lang="ts" generic="TRow extends MemberRow">
/**
 * The contact table on a segment's and a topic's detail page: search, sortable
 * header, the mobile card list below `md`, and the paging footer.
 *
 * Presentational only; `useMemberTable` owns the search, sort and paging state
 * and the page wires it through. Each row's email is a link to `rowTo(row)`, so
 * the table has a keyboard route; a click anywhere else on a desktop row goes
 * to the same place. Per-row controls (a topic's "remove") come in through the
 * `#row-actions` slot, whose scope says which layout is rendering. A failed
 * member read (`error`) shows the categorized error with Try again (`retry`),
 * never "no contacts match".
 */
import type { MemberRow } from '~/composables/useMemberTable';
import { formatDate } from '~/utils/formatters';

interface EmptyCopy {
	icon: string;
	title: string;
	description: string;
}

interface ShowingRange {
	start: number;
	end: number;
	total: number;
}

const props = defineProps<{
	/** The rows on the current page. */
	rows: TRow[];
	/** The timestamp column (`createdAt`, `addedAt`). */
	dateField: string;
	rowTo: (row: TRow) => string;
	/** The raw search input (`v-model:search`). */
	search: string;
	/** The search term the rows reflect — the debounced one. */
	activeSearch: string;
	searchPlaceholder: string;
	/** The first page is still in flight. */
	loading: boolean;
	/** The member query's `error`: a failed read is not an empty segment or topic. */
	error: Error | null;
	empty: EmptyCopy;
	isSortable: (field: string) => boolean;
	getSortIcon: (field: string) => string | null;
	currentPage: number;
	totalPages: number;
	pageNumbers: (number | '...')[];
	showingRange: ShowingRange | null;
}>();

const emit = defineEmits<{
	'update:search': [value: string];
	sort: [field: string];
	page: [page: number];
	'clear-search': [];
	retry: [];
}>();

const slots = defineSlots<{
	'row-actions'?: (props: { row: TRow; layout: 'table' | 'card' }) => unknown;
	'empty-action'?: () => unknown;
}>();

const { t } = useI18n();
const router = useRouter();

// Exactly one of the table and the card list is mounted: a CSS-only switch
// would keep both copies of every row in the DOM.
const tableFits = useDataTableViewport();

const columns = computed(() => [
	{ field: 'email', label: t('common.email') },
	{ field: 'firstName', label: t('shared.memberTable.firstName') },
	{ field: 'lastName', label: t('shared.memberTable.lastName') },
	{ field: props.dateField, label: t('shared.memberTable.added') },
]);

// `showingRange` is null exactly when no row matches (the whole filtered set,
// not just this page).
const isEmpty = computed(() => !props.loading && props.showingRange === null);

const dateOf = (row: TRow) =>
	formatDate((row as Record<string, unknown>)[props.dateField] as number | null | undefined);
const fullName = (row: TRow) => [row.firstName, row.lastName].filter(Boolean).join(' ');

// The email link is the keyboard route; the rest of the row is a mouse target
// for the same page. A click that landed on a link or a row action is theirs.
const onRowClick = (event: MouseEvent, row: TRow) => {
	if ((event.target as Element | null)?.closest('a, button')) return;
	void router.push(props.rowTo(row));
};

const showingText = computed(() =>
	props.showingRange
		? t('shared.memberTable.showing.range', { ...props.showingRange })
		: t('shared.memberTable.showing.empty')
);

const linkClass =
	'rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand';
const pagerButtonClass =
	'p-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-surface disabled:opacity-50 disabled:pointer-events-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand';
</script>

<template>
	<div>
		<div class="mb-6 max-w-md">
			<UiInput
				:model-value="search"
				:placeholder="searchPlaceholder"
				@update:model-value="emit('update:search', String($event ?? ''))"
			>
				<template #iconLeft><Icon name="lucide:search" /></template>
			</UiInput>
		</div>

		<UiCard padding="none" overflow="hidden">
			<UiQueryBoundary v-if="error" :error="error" @retry="emit('retry')" />

			<UiEmptyState
				v-else-if="isEmpty && !activeSearch"
				:icon="empty.icon"
				:title="empty.title"
				:description="empty.description"
			>
				<template v-if="slots['empty-action']" #action>
					<slot name="empty-action" />
				</template>
			</UiEmptyState>

			<UiEmptyState
				v-else-if="isEmpty"
				variant="no-results"
				icon="lucide:search"
				:title="t('shared.memberTable.noResults.title')"
				:description="t('shared.memberTable.noResults.body', { query: activeSearch })"
				:clear-label="t('shared.listPage.clearSearch')"
				@clear="emit('clear-search')"
			/>

			<div v-else>
				<ul v-if="!tableFits" class="divide-y divide-border-subtle">
					<li v-for="row in rows" :key="row._id" class="flex items-center gap-1 px-4 py-2">
						<NuxtLink :to="rowTo(row)" :class="['flex-1 min-w-0 py-1', linkClass]">
							<span class="block text-text-primary font-medium truncate">{{ row.email }}</span>
							<span v-if="fullName(row)" class="block text-sm text-text-secondary truncate">
								{{ fullName(row) }}
							</span>
							<span class="block text-xs text-text-tertiary mt-0.5">{{ dateOf(row) }}</span>
						</NuxtLink>
						<slot name="row-actions" :row="row" layout="card" />
					</li>
				</ul>

				<div v-else class="overflow-x-auto">
					<table class="w-full">
						<thead>
							<tr class="border-b border-border-subtle">
								<th
									v-for="column in columns"
									:key="column.field"
									class="text-left px-6 py-4 text-sm font-medium text-text-secondary"
								>
									<button
										v-if="isSortable(column.field)"
										type="button"
										class="flex items-center gap-1 py-4 -my-4 px-1 -mx-1 rounded hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/40"
										@click="emit('sort', column.field)"
									>
										{{ column.label }}
										<Icon
											v-if="getSortIcon(column.field)"
											:name="getSortIcon(column.field)!"
											class="w-4 h-4"
										/>
									</button>
									<template v-else>{{ column.label }}</template>
								</th>
								<th
									v-if="slots['row-actions']"
									class="text-right px-6 py-4 text-sm font-medium text-text-secondary"
								>
									{{ t('common.actions') }}
								</th>
							</tr>
						</thead>
						<tbody>
							<tr
								v-for="row in rows"
								:key="row._id"
								class="border-b border-border-subtle last:border-b-0 hover:bg-bg-surface transition-colors cursor-pointer"
								@click="onRowClick($event, row)"
							>
								<td class="px-6 py-4">
									<NuxtLink :to="rowTo(row)" :class="['text-text-primary font-medium', linkClass]">
										{{ row.email || '—' }}
									</NuxtLink>
								</td>
								<td class="px-6 py-4">
									<span class="text-text-secondary">{{ row.firstName || '—' }}</span>
								</td>
								<td class="px-6 py-4">
									<span class="text-text-secondary">{{ row.lastName || '—' }}</span>
								</td>
								<td class="px-6 py-4">
									<span class="text-text-tertiary text-sm">{{ dateOf(row) }}</span>
								</td>
								<td v-if="slots['row-actions']" class="px-6 py-4">
									<div class="flex items-center justify-end gap-1">
										<slot name="row-actions" :row="row" layout="table" />
									</div>
								</td>
							</tr>
						</tbody>
					</table>
				</div>

				<div
					class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 px-6 py-4 border-t border-border-subtle"
				>
					<p class="text-sm text-text-tertiary">
						{{ t('shared.memberTable.showing.label', { range: showingText }) }}
					</p>

					<nav
						class="flex items-center gap-1"
						:aria-label="t('shared.memberTable.pagination.label')"
					>
						<button
							type="button"
							:class="pagerButtonClass"
							:disabled="currentPage <= 1"
							:aria-label="t('shared.memberTable.pagination.previous')"
							@click="emit('page', currentPage - 1)"
						>
							<Icon name="lucide:chevron-left" class="w-4 h-4" />
						</button>

						<template v-for="(page, index) in pageNumbers" :key="index">
							<span v-if="page === '...'" class="px-2 text-text-tertiary">...</span>
							<button
								v-else
								type="button"
								:class="[
									'min-w-[32px] h-8 px-2 rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
									page === currentPage
										? 'bg-text-primary text-text-inverse'
										: 'text-text-secondary hover:text-text-primary hover:bg-bg-surface',
								]"
								:aria-current="page === currentPage ? 'page' : undefined"
								@click="emit('page', page)"
							>
								{{ page }}
							</button>
						</template>

						<button
							type="button"
							:class="pagerButtonClass"
							:disabled="currentPage >= totalPages"
							:aria-label="t('shared.memberTable.pagination.next')"
							@click="emit('page', currentPage + 1)"
						>
							<Icon name="lucide:chevron-right" class="w-4 h-4" />
						</button>
					</nav>
				</div>
			</div>
		</UiCard>
	</div>
</template>
