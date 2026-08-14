<script setup lang="ts">
import { api } from '@owlat/api';

// Single-select conversation picker: search the shared inbox by subject or
// participant and pick the thread a file belongs to (file detail page). The
// model is the full row so the caller can render the chosen subject without a
// second lookup; it maps to `threadId` for `semanticFiles.update`.
const selected = defineModel<PickerThread | null>({ default: null });

const { t } = useI18n();

const search = ref('');

// `conversationThreads` carries no full-text index, so — like the chat
// "link an email thread" dialog — we pull a bounded recent page and filter it
// in the browser.
const { data: threadsData, isLoading } = useConvexQuery(api.inbox.queries.listThreads, () => ({
	limit: 100,
}));

const candidates = computed(() =>
	filterThreadCandidates(threadsData.value?.threads ?? [], search.value).slice(0, 8),
);

const pick = (thread: PickerThread) => {
	selected.value = thread;
	search.value = '';
};
</script>

<template>
	<div class="space-y-2">
		<!-- Current selection as a removable chip -->
		<div v-if="selected" class="flex flex-wrap gap-1.5">
			<span
				class="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 text-xs font-medium rounded-full bg-bg-surface text-text-secondary"
			>
				<Icon name="lucide:message-square" class="w-3 h-3 text-text-tertiary" />
				<span class="truncate max-w-[12rem]">{{ threadPickerLabel(selected) }}</span>
				<button
					type="button"
					class="p-0.5 rounded-full text-text-tertiary hover:text-error hover:bg-error-subtle transition-colors"
					:aria-label="
						t('components.files.threadPicker.remove', { name: threadPickerLabel(selected) })
					"
					@click="selected = null"
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
				:placeholder="t('components.files.threadPicker.searchPlaceholder')"
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
						<span class="block truncate">{{ threadPickerLabel(candidate) }}</span>
						<span v-if="candidate.contactIdentifier" class="block text-xs text-text-tertiary truncate">
							{{ candidate.contactIdentifier }}
						</span>
					</button>
				</li>
			</ul>
			<p v-else-if="search && !isLoading" class="text-xs text-text-tertiary mt-1">
				{{ t('components.files.threadPicker.empty') }}
			</p>
		</div>
	</div>
</template>
