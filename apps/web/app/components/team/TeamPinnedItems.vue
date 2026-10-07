<script setup lang="ts">
/** "Open for the team" wired to a team thread's actions (`useTeamThread`). */
import type { TeamThread } from '~/composables/team/useTeamThread';
import TeamOpenItems from './TeamOpenItems.vue';

defineProps<{ team: TeamThread }>();
</script>

<template>
	<TeamOpenItems
		:view="team.openItems.value"
		:viewer-id="team.viewerId.value"
		:members="team.members.value"
		:note-counts="team.noteCounts.value"
		@act="team.act"
		@assign="team.assign"
	/>
</template>
