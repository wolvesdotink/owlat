<script setup lang="ts">
/**
 * The team's internal notes and the system lines that follow one email of a
 * shared-mailbox thread (or come before the first one shown), placed between
 * the reader's messages by `usePostboxTeamStream`.
 */
import type { TeamStreamEntry } from '../../../../api/convex/mail/interpret/briefShape';
import type { PostboxTeamStream } from '~/composables/postbox/usePostboxTeamStream';
import TeamThreadStream from '~/components/team/TeamThreadStream.vue';

defineProps<{ state: PostboxTeamStream; entries: readonly TeamStreamEntry[] }>();
</script>

<template>
	<TeamThreadStream
		v-if="state.isActive.value && entries.length > 0"
		class="py-1"
		:entries="entries"
		:viewer-id="state.team.viewerId.value"
		:member-name="state.team.memberName"
		:can-react="state.notesEnabled.value"
		@react-note="state.team.reactNote"
	/>
</template>
