<script setup lang="ts">
/**
 * "Open for the team" wired to a team thread's actions (`useTeamThread`).
 * Source markers name who sent the cited email and when (from the stream);
 * a click brings that email into view in the stream and rings it, walking
 * the stream back until it is loaded.
 */
import type { TeamThread } from '~/composables/team/useTeamThread';
import { citedMessageId, streamSources } from '~/utils/teamCite';
import TeamOpenItems from './TeamOpenItems.vue';

const props = defineProps<{ team: TeamThread }>();

const sources = computed(() => streamSources(props.team.stream.entries.value));
/** The email a marker asked for, while older pages are still loading. */
const wanted = ref<string | null>(null);

function show(messageId: string): boolean {
	const el = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
	if (!el) return false;
	const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
	el.scrollIntoView?.({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
	el.classList.add('ring-2', 'ring-brand/50');
	setTimeout(() => el.classList.remove('ring-2', 'ring-brand/50'), 1600);
	return true;
}

function cite(ref: string, quoteIndex: number) {
	const id = citedMessageId(props.team.openItems.value, ref, quoteIndex);
	if (!id) return;
	wanted.value = id;
	void nextTick(seek);
}

/** Show the wanted email, loading older stream pages until it is there. */
function seek() {
	const id = wanted.value;
	if (!id) return;
	if (show(id)) {
		wanted.value = null;
		return;
	}
	const stream = props.team.stream;
	if (stream.hasEarlier.value) stream.loadEarlier();
	else wanted.value = null;
}
watch(
	() => props.team.stream.entries.value.length,
	() => void nextTick(seek)
);
</script>

<template>
	<TeamOpenItems
		:view="team.openItems.value"
		:viewer-id="team.viewerId.value"
		:members="team.members.value"
		:note-counts="team.noteCounts.value"
		:source-of="(id: string) => sources.get(id)"
		@act="team.act"
		@assign="team.assign"
		@cite="cite"
	/>
</template>
