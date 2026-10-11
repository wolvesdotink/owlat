<script setup lang="ts">
/**
 * "Open for the team" wired to a team thread's actions (`useTeamThread`), with
 * its source markers (`useTeamCite`). The host's attributes (its spacing
 * class) are bound to the strip itself, so nothing is dropped and an empty
 * strip leaves no gap.
 */
import type { TeamThread } from '~/composables/team/useTeamThread';
import { useTeamCite } from '~/composables/team/useTeamCite';
import TeamOpenItems from './TeamOpenItems.vue';

defineOptions({ inheritAttrs: false });

const props = defineProps<{
	team: TeamThread;
	/**
	 * Show a message through the host's own paging (the shared-mailbox reader,
	 * which renders the emails itself); without it the stream is walked back.
	 */
	citeMessage?: (messageId: string) => void;
	/** The host could not load the cited email. */
	citeUnreachable?: boolean;
}>();

const { t } = useI18n();
const context = useTeamCite({
	stream: props.team.stream,
	view: props.team.openItems,
	memberName: props.team.memberName,
	citeMessage: () => props.citeMessage,
});
</script>

<template>
	<p
		v-if="citeUnreachable"
		role="status"
		class="mb-2 rounded-lg bg-warning-subtle px-3 py-2 text-xs text-warning"
		data-testid="team-cite-unreachable"
	>
		{{ t('components.team.items.citeUnreachable') }}
	</p>
	<!-- The host's class (spacing) goes on the strip, which hides itself when empty. -->
	<TeamOpenItems
		v-bind="$attrs"
		:view="team.openItems.value"
		:viewer-id="team.viewerId.value"
		:members="team.members.value"
		:note-counts="team.noteCounts.value"
		:source-of="context.sourceOf"
		@act="team.act"
		@assign="team.assign"
		@cite="context.cite"
	/>
</template>
