<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { CloseIcon, UserIcon } from '@coolicons/vue';

// Multi-select contact picker: search contacts by name/email and collect a set
// of them as removable chips. Used to associate an uploaded document with the
// people it concerns (file upload modal + file detail page). The selection is a
// v-model of full contact rows so the chips can show a label without a second
// lookup; callers map to `contactIds` for `semanticFiles.create`/`update`.
const selected = defineModel<PickerContact[]>({ default: () => [] });

const props = defineProps<{
	/** Id for the search field, so a caller's `<label for>` names it. */
	inputId?: string;
}>();

const { t } = useI18n();

const { query: search, debouncedQuery } = useDebouncedSearch(300);

const { results: candidatesRaw } = usePaginatedQuery(
	api.contacts.contacts.list,
	() => ({ search: debouncedQuery.value || undefined }),
	{ initialNumItems: 8 }
);

// Only offer contacts that aren't already chosen.
const candidates = computed(() =>
	unselectedCandidates(candidatesRaw.value as PickerContact[], selected.value)
);

// Until the debounced query catches up with what was typed, the list still
// shows the previous search; say so instead of flashing "no matches".
const isSearching = computed(() => search.value.trim() !== debouncedQuery.value.trim());

const pick = (contact: PickerContact) => {
	selected.value = addPickedContact(selected.value, contact);
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

const unpick = (contactId: Id<'contacts'>) => {
	selected.value = removePickedContact(selected.value, contactId);
};
</script>

<template>
	<div class="space-y-2">
		<!-- Selected contacts as removable chips -->
		<div v-if="selected.length > 0" class="flex flex-wrap gap-1.5">
			<span
				v-for="contact in selected"
				:key="contact._id"
				class="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 text-xs font-medium rounded-full bg-bg-surface text-text-secondary"
			>
				<UserIcon class="w-3 h-3 text-text-tertiary" aria-hidden="true" />
				{{ contactPickerLabel(contact) }}
				<button
					type="button"
					class="p-0.5 rounded-full text-text-tertiary hover:text-error hover:bg-error-subtle transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
					:aria-label="
						t('components.files.contactPicker.remove', { name: contactPickerLabel(contact) })
					"
					@click="unpick(contact._id)"
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
				:placeholder="t('components.files.contactPicker.searchPlaceholder')"
				:aria-label="
					props.inputId ? undefined : t('components.files.contactPicker.searchPlaceholder')
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
						{{ contactPickerLabel(candidate) }}
						<span
							v-if="(candidate.firstName || candidate.lastName) && candidate.email"
							class="text-text-tertiary"
						>
							· {{ candidate.email }}</span
						>
					</button>
				</li>
			</ul>
			<p v-else-if="search && isSearching" class="text-xs text-text-tertiary mt-1" role="status">
				{{ t('components.files.picker.searching') }}
			</p>
			<p
				v-else-if="search && candidates.length === 0"
				class="text-xs text-text-tertiary mt-1"
				role="status"
			>
				{{ t('components.files.contactPicker.empty') }}
			</p>
		</div>
	</div>
</template>
