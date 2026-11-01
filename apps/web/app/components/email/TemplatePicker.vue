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
 * Keyboard: the input is the shared `UiCombobox` over an always-visible
 * `UiListbox`. Arrow keys, Home and End move the active option, Enter picks
 * it, Escape clears the query; arrowing onto the last loaded row pages in more.
 */
import { api } from '@owlat/api';
import type { Doc, Id } from '@owlat/api/dataModel';
import { CheckIcon, SearchIcon } from '@coolicons/vue';

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

function loadMore() {
	if (status.value === 'CanLoadMore') loadPage(PAGE_SIZE);
}

function onListScroll(event: Event) {
	const el = event.currentTarget as HTMLElement;
	if (el.scrollTop + el.clientHeight >= el.scrollHeight - LOAD_MORE_THRESHOLD) loadMore();
}

/** Arrowing onto the last loaded row pages in the next batch, like scrolling to the end. */
function onHighlight(template: Doc<'emailTemplates'> | null) {
	if (template && template._id === templates.value.at(-1)?._id) loadMore();
}

function choose(template: Doc<'emailTemplates'>) {
	emit('update:modelValue', template._id);
	emit('select', template);
}
</script>

<template>
	<UiCombobox
		v-model:query="query"
		:input-id="inputId"
		inline
		:label="t('components.email.templatePicker.listLabel')"
		:placeholder="t('components.email.templatePicker.searchPlaceholder')"
		input-class="input pl-10"
		input-testid="template-picker-input"
	>
		<template #leading>
			<SearchIcon
				class="w-4 h-4 text-text-tertiary absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
			/>
		</template>

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

				<UiListbox
					:id="listId"
					:options="templates"
					:option-key="(template: Doc<'emailTemplates'>) => template._id"
					:label="t('components.email.templatePicker.listLabel')"
					:model-value="modelValue ?? null"
					class="max-h-72 overflow-y-auto divide-y divide-border-subtle"
					option-class="flex items-center justify-between gap-3 p-3 transition-colors motion-reduce:transition-none data-highlighted:bg-bg-surface data-highlighted:ring-2 data-highlighted:ring-inset data-highlighted:ring-brand"
					data-testid="template-picker-list"
					@select="choose"
					@highlight="onHighlight"
					@scroll.passive="onListScroll"
				>
					<template #option="{ option: template, selected }">
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
									selected
										? 'border-text-primary bg-text-primary text-text-inverse'
										: 'border-border-default text-transparent',
								]"
								aria-hidden="true"
							>
								<CheckIcon class="w-3 h-3" />
							</span>
						</div>
					</template>
				</UiListbox>
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
	</UiCombobox>
</template>
