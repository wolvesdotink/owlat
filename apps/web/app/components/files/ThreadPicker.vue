<script setup lang="ts">
import { api } from '@owlat/api';
import { ChatIcon, CloseIcon } from '@coolicons/vue';

// Single-select conversation picker: search the shared inbox by subject or
// participant and pick the thread a file belongs to (file detail page). The
// model is the full row so the caller can render the chosen subject without a
// second lookup; it maps to `threadId` for `files.library.update`.
const selected = defineModel<PickerThread | null>({ default: null });

const props = defineProps<{
	/** Id for the search field, so a caller's `<label for>` names it. */
	inputId?: string;
}>();

const { t } = useI18n();

// The search runs on the SERVER (`inbox.queries.listThreads`' `search` argument,
// over the subject and the participant address), so the dropdown sees the whole
// shared inbox rather than one bounded page. Nothing is subscribed until
// something is typed; the picker only renders candidates then anyway.
const { query: search, debouncedQuery } = useDebouncedSearch();

const { data: threadsData, isLoading } = useConvexQuery(api.inbox.queries.listThreads, () =>
	debouncedQuery.value.trim() ? { search: debouncedQuery.value.trim(), limit: 8 } : 'skip'
);

const candidates = computed<PickerThread[]>(() =>
	search.value.trim() ? (threadsData.value?.threads ?? []) : []
);

// A skipped read reports not-loading, so "no matches" would flash while the
// debounce is pending; treat the gap between typed and debounced as searching.
const isSearching = computed(
	() => search.value.trim() !== debouncedQuery.value.trim() || isLoading.value
);

const pick = (thread: PickerThread) => {
	selected.value = thread;
	search.value = '';
	inputRef.value?.focus();
};

// Arrow keys move between the search box and the result buttons; Escape clears.
const listRef = ref<HTMLElement | null>(null);
const inputRef = ref<HTMLInputElement | null>(null);
const optionButtons = () =>
	Array.from(listRef.value?.querySelectorAll<HTMLButtonElement>('button') ?? []);
const onInputKeydown = (event: KeyboardEvent) => {
	if (event.key === 'ArrowDown') {
		const first = optionButtons()[0];
		if (first) {
			event.preventDefault();
			first.focus();
		}
	} else if (event.key === 'Escape' && search.value) {
		event.preventDefault();
		event.stopPropagation();
		search.value = '';
	}
};
const onOptionKeydown = (event: KeyboardEvent, index: number) => {
	const buttons = optionButtons();
	if (event.key === 'ArrowDown') {
		event.preventDefault();
		buttons[Math.min(index + 1, buttons.length - 1)]?.focus();
	} else if (event.key === 'ArrowUp') {
		event.preventDefault();
		if (index === 0) inputRef.value?.focus();
		else buttons[index - 1]?.focus();
	} else if (event.key === 'Escape') {
		event.preventDefault();
		event.stopPropagation();
		search.value = '';
		inputRef.value?.focus();
	}
};
</script>

<template>
	<div class="space-y-2">
		<!-- Current selection as a removable chip -->
		<div v-if="selected" class="flex flex-wrap gap-1.5">
			<span
				class="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 text-xs font-medium rounded-full bg-bg-surface text-text-secondary"
			>
				<ChatIcon class="w-3 h-3 text-text-tertiary" aria-hidden="true" />
				<span class="truncate max-w-[12rem]" :title="threadPickerLabel(selected)">{{
					threadPickerLabel(selected)
				}}</span>
				<button
					type="button"
					class="p-0.5 rounded-full text-text-tertiary hover:text-error hover:bg-error-subtle transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
					:aria-label="
						t('components.files.threadPicker.remove', { name: threadPickerLabel(selected) })
					"
					@click="selected = null"
				>
					<CloseIcon class="w-3 h-3" />
				</button>
			</span>
		</div>

		<!-- Search + candidate dropdown -->
		<div class="relative">
			<input
				:id="props.inputId"
				ref="inputRef"
				v-model="search"
				type="search"
				class="input input-sm"
				:placeholder="t('components.files.threadPicker.searchPlaceholder')"
				:aria-label="
					props.inputId ? undefined : t('components.files.threadPicker.searchPlaceholder')
				"
				autocomplete="off"
				@keydown="onInputKeydown"
			/>
			<ul
				v-if="search && candidates.length > 0"
				ref="listRef"
				class="absolute z-10 mt-1 w-full max-h-56 overflow-auto rounded-lg surface-3"
			>
				<li v-for="(candidate, index) in candidates" :key="candidate._id">
					<button
						type="button"
						class="w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-bg-surface-hover focus-visible:bg-bg-surface-hover focus-visible:outline-none transition-colors"
						@click="pick(candidate)"
						@keydown="onOptionKeydown($event, index)"
					>
						<span class="block truncate">{{ threadPickerLabel(candidate) }}</span>
						<span
							v-if="candidate.contactIdentifier"
							class="block text-xs text-text-tertiary truncate"
						>
							{{ candidate.contactIdentifier }}
						</span>
					</button>
				</li>
			</ul>
			<p
				v-else-if="search.trim() && isSearching"
				class="text-xs text-text-tertiary mt-1"
				role="status"
			>
				{{ t('components.files.picker.searching') }}
			</p>
			<p v-else-if="search.trim()" class="text-xs text-text-tertiary mt-1" role="status">
				{{ t('components.files.threadPicker.empty') }}
			</p>
		</div>
	</div>
</template>
