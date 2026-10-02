<script setup lang="ts">
/**
 * The end of a Team Inbox thread: Reply beside Note.
 *
 * Reply opens Answer mode, where every reply is written (`r`). Note opens the
 * internal note box right here (`n`), so a teammate can leave context or ask
 * someone with an @-mention without leaving the thread. The two sit side by
 * side so the choice between "the customer reads this" and "only the team
 * does" is made before anything is typed.
 */
import type { ThreadNotes } from '~/composables/useThreadNotes';

const props = defineProps<{
	notes: ThreadNotes;
	/** "Reply to Ines Weber"; null when the thread has nothing to reply to. */
	replyLabel: string | null;
}>();

const emit = defineEmits<{ (e: 'reply'): void }>();

const { t } = useI18n();

const noteOpen = ref(false);
const composer = ref<{ focus: () => void } | null>(null);

/** Open the note box and put the cursor in it (the `n` key). */
function openNote() {
	noteOpen.value = true;
	void nextTick(() => composer.value?.focus());
}

defineExpose({ openNote });
</script>

<template>
	<div class="card space-y-3" data-testid="thread-compose-bar">
		<div class="flex flex-wrap items-center gap-2">
			<button
				v-if="replyLabel"
				type="button"
				class="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-1 py-1 text-left text-sm text-text-tertiary transition-colors duration-(--motion-fast) hover:text-text-primary"
				data-testid="thread-reply-open"
				@click="emit('reply')"
			>
				<Icon name="lucide:reply" class="w-4 h-4 shrink-0" />
				<span class="min-w-0 flex-1 truncate">{{ replyLabel }}</span>
				<kbd
					class="hidden sm:inline px-1 py-px rounded border border-border-subtle bg-bg-surface font-mono text-[10px] text-text-secondary"
					aria-hidden="true"
					>R</kbd
				>
			</button>
			<button
				type="button"
				class="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors duration-(--motion-fast)"
				:class="[
					noteOpen
						? 'border-warning/40 bg-warning/10 text-text-primary'
						: 'border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-surface',
					replyLabel ? '' : 'flex-1',
				]"
				:aria-expanded="noteOpen"
				data-testid="thread-note-open"
				@click="noteOpen ? (noteOpen = false) : openNote()"
			>
				<Icon name="lucide:sticky-note" class="w-4 h-4 shrink-0" />
				<span>{{ t('components.inbox.notes.open') }}</span>
				<kbd
					class="hidden sm:inline px-1 py-px rounded border border-border-subtle bg-bg-surface font-mono text-[10px] text-text-secondary"
					aria-hidden="true"
					>N</kbd
				>
			</button>
		</div>
		<!-- v-show, not v-if: closing the box (or Esc) keeps what was typed. -->
		<InboxNoteComposer
			v-show="noteOpen"
			ref="composer"
			:submit="props.notes.post"
			:candidates-for="props.notes.candidatesFor"
			@cancel="noteOpen = false"
		/>
	</div>
</template>
