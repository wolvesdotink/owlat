<script setup lang="ts">
/**
 * The foot of a shared-mailbox thread: an internal note to the team (the
 * thread's discussion, when chat is on) or the reply to the customer, which
 * opens Answer mode with what was typed (`usePostboxTeamStream`).
 */
import type { PostboxTeamStream } from '~/composables/postbox/usePostboxTeamStream';
import TeamNoteComposer from '~/components/team/TeamNoteComposer.vue';

const props = defineProps<{ state: PostboxTeamStream; threadId: string; counterparty?: string }>();

const replyDraft = computed({
	get: () => props.state.replyDraft.value,
	set: (text: string) => (props.state.replyDraft.value = text),
});
</script>

<template>
	<TeamNoteComposer
		v-if="state.isActive.value"
		v-model:reply-draft="replyDraft"
		class="mt-4"
		:draft-key="`mail:${threadId}`"
		:reply-name="counterparty || null"
		:notes-enabled="state.notesEnabled.value"
		:items="state.team.items.value"
		:candidates-for="state.team.candidatesFor"
		:submit-note="state.team.postNote"
		@reply="state.continueReply"
	/>
</template>
