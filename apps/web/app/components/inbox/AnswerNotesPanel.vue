<script setup lang="ts">
/**
 * Answer mode's Note tab: the thread's internal notes, oldest first, and the
 * box to add one. The person answering sees what the team said about the
 * thread without leaving the reply, and can ask someone with an @-mention.
 * Nothing here goes into the reply or to the agent drafting it.
 */
import type { ThreadNotes } from '~/composables/useThreadNotes';

defineProps<{
	notes: ThreadNotes;
	isAdmin: boolean;
}>();

const { t } = useI18n();
</script>

<template>
	<div class="flex min-h-0 flex-1 flex-col" data-testid="answer-notes-panel">
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
			<InboxNoteComposer :submit="notes.post" :candidates-for="notes.candidatesFor" />
		</div>
	</div>
</template>
