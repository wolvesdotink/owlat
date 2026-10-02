<script setup lang="ts">
/**
 * A run of internal notes: the ones between two messages of the thread view,
 * or all of them in Answer mode's Note tab. Owns who may edit or delete each
 * (its author edits; its author or an admin deletes, as the server checks)
 * and the "Delete this note?" confirmation.
 */
import type { ThreadNotes } from '~/composables/useThreadNotes';
import type { ThreadNoteView } from '~/components/inbox/ThreadNote.vue';

const props = defineProps<{
	items: readonly ThreadNoteView[];
	notes: ThreadNotes;
	/** The viewer administers the workspace: they may delete anyone's note. */
	isAdmin: boolean;
}>();

const { t } = useI18n();

const me = computed(() => props.notes.currentUserId.value);
const pendingDelete = ref<ThreadNoteView | null>(null);
const deleting = ref(false);

async function confirmDelete() {
	const note = pendingDelete.value;
	if (!note || deleting.value) return;
	deleting.value = true;
	try {
		if (await props.notes.destroy(note._id)) pendingDelete.value = null;
	} finally {
		deleting.value = false;
	}
}
</script>

<template>
	<div class="space-y-3">
		<InboxThreadNote
			v-for="note in items"
			:key="note._id"
			:note="note"
			:can-edit="note.authorId === me"
			:can-delete="note.authorId === me || isAdmin"
			:save="(body: string) => notes.edit(note._id, body)"
			:candidates-for="notes.candidatesFor"
			@delete="pendingDelete = note"
		/>
		<UiConfirmationDialog
			:open="!!pendingDelete"
			variant="danger"
			:title="t('components.inbox.notes.deleteDialog.title')"
			:description="t('components.inbox.notes.deleteDialog.description')"
			:confirm-text="t('components.inbox.notes.delete')"
			:is-loading="deleting"
			@update:open="(v: boolean) => !v && (pendingDelete = null)"
			@confirm="confirmDelete"
		/>
	</div>
</template>
