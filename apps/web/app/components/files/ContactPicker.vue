<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

// Multi-select contact picker: search contacts by name/email and collect a set
// of them as removable chips. Used to associate an uploaded document with the
// people it concerns (file upload modal + file detail page). The selection is a
// v-model of full contact rows so the chips can show a label without a second
// lookup; callers map to `contactIds` for `semanticFiles.create`/`update`.
const selected = defineModel<PickerContact[]>({ default: () => [] });

const { query: search, debouncedQuery } = useDebouncedSearch(300);

const { results: candidatesRaw } = usePaginatedQuery(
	api.contacts.contacts.list,
	() => ({ search: debouncedQuery.value || undefined }),
	{ initialNumItems: 8 },
);

// Only offer contacts that aren't already chosen.
const candidates = computed(() =>
	unselectedCandidates(candidatesRaw.value as PickerContact[], selected.value),
);

const pick = (contact: PickerContact) => {
	selected.value = addPickedContact(selected.value, contact);
	search.value = '';
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
				<Icon name="lucide:user" class="w-3 h-3 text-text-tertiary" />
				{{ contactPickerLabel(contact) }}
				<button
					type="button"
					class="p-0.5 rounded-full text-text-tertiary hover:text-error hover:bg-error-subtle transition-colors"
					:aria-label="`Remove ${contactPickerLabel(contact)}`"
					@click="unpick(contact._id)"
				>
					<Icon name="lucide:x" class="w-3 h-3" />
				</button>
			</span>
		</div>

		<!-- Search + candidate dropdown -->
		<div class="relative">
			<input
				v-model="search"
				type="text"
				class="w-full rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent"
				placeholder="Search contacts by name or email…"
				autocomplete="off"
			/>
			<ul
				v-if="search && candidates.length > 0"
				class="absolute z-10 mt-1 w-full max-h-56 overflow-auto rounded-lg border border-border-subtle bg-bg-elevated shadow-lg"
			>
				<li v-for="candidate in candidates" :key="candidate._id">
					<button
						type="button"
						class="w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-bg-surface transition-colors"
						@click="pick(candidate)"
					>
						{{ contactPickerLabel(candidate) }}
						<span
							v-if="(candidate.firstName || candidate.lastName) && candidate.email"
							class="text-text-tertiary"
						> · {{ candidate.email }}</span>
					</button>
				</li>
			</ul>
			<p
				v-else-if="search && candidates.length === 0"
				class="text-xs text-text-tertiary mt-1"
			>
				No matching contacts.
			</p>
		</div>
	</div>
</template>
