<script setup lang="ts">
/**
 * Searchable email-template picker, shared by campaign Content and the
 * automation email step.
 *
 * The search runs on the server (`emails.list`'s `search` argument, backed by
 * the `search_templates` index), so a template beyond the first page is found
 * by typing its name or subject. With no query the list pages in more rows as
 * it scrolls to the end, with a "Load more" button as the explicit fallback.
 *
 * The picker only lists and selects. Showing the current selection is the
 * surface's job, through `useEmailTemplateById`, so a selected template outside
 * the current results still renders.
 *
 * Keyboard: the input is an ARIA combobox over an always-visible listbox.
 * Arrow keys, Home and End move the active option, Enter picks it, Escape
 * clears the query.
 */
import { api } from '@owlat/api';
import type { Doc, Id } from '@owlat/api/dataModel';

type TemplateType = 'marketing' | 'transactional';

const props = withDefaults(
	defineProps<{
		modelValue: Id<'emailTemplates'> | null | undefined;
		/** Id for the search input, so the surface's `<label for>` names it. */
		inputId: string;
		type?: TemplateType;
	}>(),
	{ type: 'marketing' }
);

const emit = defineEmits<{
	'update:modelValue': [value: Id<'emailTemplates'>];
	select: [template: Doc<'emailTemplates'>];
}>();

defineSlots<{
	/** Replaces the "no templates yet" note (shown only when no query is set). */
	none?: () => unknown;
}>();

const { t } = useI18n();

/** Rows per page. A page overflows the list box, so scrolling reaches its end. */
const PAGE_SIZE = 25;
/** Distance from the bottom, in px, at which the next page starts loading. */
const LOAD_MORE_THRESHOLD = 48;

const { query, debouncedQuery } = useDebouncedSearch(250);
const search = computed(() => debouncedQuery.value.trim());

const {
	results,
	status,
	isLoading,
	error,
	refetch,
	loadMore: loadPage,
} = useOrganizationPaginatedQuery(
	api.emailTemplates.emails.list,
	() => ({ type: props.type, ...(search.value ? { search: search.value } : {}) }),
	{ initialNumItems: PAGE_SIZE }
);

const templates = computed(() => results.value as Doc<'emailTemplates'>[]);

/** The typed query has not reached the server yet, or its answer has not come back. */
const pending = computed(() => query.value.trim() !== search.value || isLoading.value);

const listId = useId();
const optionId = (id: string) => `${listId}-${id}`;
const activeIndex = ref(-1);
const listEl = ref<HTMLElement | null>(null);

watch(templates, (rows) => {
	if (activeIndex.value >= rows.length) activeIndex.value = rows.length - 1;
});
watch(search, () => {
	activeIndex.value = -1;
	listEl.value?.scrollTo?.({ top: 0 });
});

const activeDescendant = computed(() => {
	const row = templates.value[activeIndex.value];
	return row && !pending.value ? optionId(row._id) : undefined;
});

function loadMore() {
	if (status.value === 'CanLoadMore') loadPage(PAGE_SIZE);
}

function onListScroll() {
	const el = listEl.value;
	if (!el) return;
	if (el.scrollTop + el.clientHeight >= el.scrollHeight - LOAD_MORE_THRESHOLD) loadMore();
}

function choose(template: Doc<'emailTemplates'>) {
	emit('update:modelValue', template._id);
	emit('select', template);
}

function moveActive(index: number) {
	const count = templates.value.length;
	if (count === 0) return;
	activeIndex.value = Math.min(Math.max(index, 0), count - 1);
	const row = templates.value[activeIndex.value]!;
	nextTick(() => {
		document.getElementById(optionId(row._id))?.scrollIntoView?.({ block: 'nearest' });
		// Arrowing onto the last loaded row pages in the next batch, the
		// keyboard equivalent of scrolling to the end.
		if (activeIndex.value === templates.value.length - 1) loadMore();
	});
}

function onKeydown(event: KeyboardEvent) {
	switch (event.key) {
		case 'ArrowDown':
			event.preventDefault();
			moveActive(activeIndex.value + 1);
			break;
		case 'ArrowUp':
			event.preventDefault();
			moveActive(activeIndex.value - 1);
			break;
		case 'Home':
			if (!templates.value.length) return;
			event.preventDefault();
			moveActive(0);
			break;
		case 'End':
			if (!templates.value.length) return;
			event.preventDefault();
			moveActive(templates.value.length - 1);
			break;
		case 'Enter': {
			// Enter inside a form would otherwise submit it.
			event.preventDefault();
			const row = templates.value[activeIndex.value];
			if (row && !pending.value) choose(row);
			break;
		}
		case 'Escape':
			if (!query.value) return;
			event.preventDefault();
			query.value = '';
			break;
	}
}
</script>

<template>
	<div>
		<div class="relative">
			<Icon
				name="lucide:search"
				class="w-4 h-4 text-text-tertiary absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
			/>
			<input
				:id="inputId"
				v-model="query"
				type="text"
				role="combobox"
				aria-autocomplete="list"
				aria-expanded="true"
				:aria-controls="listId"
				:aria-activedescendant="activeDescendant"
				autocomplete="off"
				:placeholder="t('components.email.templatePicker.searchPlaceholder')"
				class="input pl-10"
				data-testid="template-picker-input"
				@keydown="onKeydown"
			/>
		</div>

		<div class="mt-3 border border-border-subtle rounded-lg overflow-hidden">
			<UiQueryBoundary
				:loading="pending"
				:error="error"
				:empty="templates.length === 0"
				@retry="refetch"
			>
				<template #loading>
					<p
						role="status"
						class="flex items-center gap-2 p-4 text-sm text-text-secondary"
						data-testid="template-picker-pending"
					>
						<UiSpinner size="xs" />
						{{
							search || query.trim()
								? t('components.email.templatePicker.searching')
								: t('components.email.templatePicker.loading')
						}}
					</p>
				</template>
				<template #empty>
					<div
						role="status"
						class="p-4 text-sm text-text-secondary bg-bg-surface"
						data-testid="template-picker-empty"
					>
						<template v-if="search">{{ t('components.email.templatePicker.noMatches') }}</template>
						<slot v-else name="none">{{ t('components.email.templatePicker.none') }}</slot>
					</div>
				</template>

				<ul
					:id="listId"
					ref="listEl"
					role="listbox"
					:aria-label="t('components.email.templatePicker.listLabel')"
					class="max-h-72 overflow-y-auto divide-y divide-border-subtle"
					data-testid="template-picker-list"
					@scroll.passive="onListScroll"
				>
					<li
						v-for="(template, index) in templates"
						:id="optionId(template._id)"
						:key="template._id"
						role="option"
						:aria-selected="template._id === modelValue"
						:class="[
							'flex items-center justify-between gap-3 p-3 cursor-pointer transition-colors motion-reduce:transition-none',
							index === activeIndex
								? 'bg-bg-surface ring-2 ring-inset ring-brand'
								: 'hover:bg-bg-surface',
						]"
						data-testid="template-picker-option"
						@mousedown.prevent
						@click="choose(template)"
						@mousemove="activeIndex = index"
					>
						<div class="min-w-0">
							<p class="font-medium text-text-primary truncate">{{ template.name }}</p>
							<p class="text-sm text-text-secondary truncate">
								{{ template.subject || t('components.email.templatePicker.noSubject') }}
							</p>
						</div>
						<div class="flex items-center gap-2 shrink-0">
							<SendTemplateStatusBadge :status="template.status" />
							<span
								:class="[
									'w-5 h-5 rounded-full border flex items-center justify-center',
									template._id === modelValue
										? 'border-text-primary bg-text-primary text-text-inverse'
										: 'border-border-default text-transparent',
								]"
								aria-hidden="true"
							>
								<Icon name="lucide:check" class="w-3 h-3" />
							</span>
						</div>
					</li>
				</ul>
				<p
					v-if="status === 'LoadingMore'"
					role="status"
					class="flex items-center gap-2 px-3 py-2 text-sm text-text-secondary border-t border-border-subtle"
				>
					<UiSpinner size="xs" />
					{{ t('components.email.templatePicker.loadingMore') }}
				</p>
				<div v-else-if="status === 'CanLoadMore'" class="p-2 border-t border-border-subtle">
					<UiButton
						variant="ghost"
						size="sm"
						full-width
						data-testid="template-picker-load-more"
						@click="loadMore"
					>
						{{ t('components.email.templatePicker.loadMore') }}
					</UiButton>
				</div>
			</UiQueryBoundary>
		</div>
	</div>
</template>
