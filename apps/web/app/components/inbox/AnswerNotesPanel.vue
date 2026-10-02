<script setup lang="ts">
/**
 * Answer mode's Note tab: the thread's internal notes, oldest first, and the
 * box to add one. The person answering sees what the team said about the
 * thread without leaving the reply, and can ask someone with an @-mention.
 * Nothing here goes into the reply or to the agent drafting it.
 */
import type { ThreadNotes } from '~/composables/useThreadNotes';

const props = defineProps<{
	notes: ThreadNotes;
	isAdmin: boolean;
	/** The Note tab is showing. Hidden, not unmounted, so a half-written note survives Reply. */
	active: boolean;
}>();

const { t } = useI18n();

// Switching to the tab (a click or `n`) puts the cursor in the note box.
const composer = ref<{ focus: () => void } | null>(null);
watch(
	() => props.active,
	(active) => {
		if (active) void nextTick(() => composer.value?.focus());
	},
	{ immediate: true }
);
</script>

<template>
	<div v-show="active" class="flex min-h-0 flex-1 flex-col" data-testid="answer-notes-panel">
		<div class="min-h-0 flex-1 overflow-y-auto p-4">
			<UiQueryBoundary
				:loading="notes.isLoading.value && notes.notes.value.length === 0"
				:error="notes.error.value"
				:empty="notes.notes.value.length === 0"
				@retry="notes.refetch"
			>
				<template #empty>
					<p class="py-8 text-center text-sm text-text-tertiary" data-testid="answer-notes-empty">
						{{ t('components.inbox.notes.empty') }}
					</p>
				</template>
				<!-- `ml-0` cancels the thread view's indent: here the notes stand alone. -->
				<InboxNoteList
					class="[&_article]:ml-0"
					:items="notes.notes.value"
					:notes="notes"
					:is-admin="isAdmin"
				/>
			</UiQueryBoundary>
		</div>
		<div class="shrink-0 border-t border-border-subtle p-3">
			<InboxNoteComposer
				ref="composer"
				:submit="notes.post"
				:candidates-for="notes.candidatesFor"
			/>
		</div>
	</div>
</template>
