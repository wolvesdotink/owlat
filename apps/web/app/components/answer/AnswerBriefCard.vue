<script setup lang="ts">
/**
 * Answer mode's view of the thread being answered (SPEC §7), in place of the
 * catch-up card:
 *
 *  - a personal mailbox: the thread brief with selectable items;
 *  - a shared (team) mailbox: the actions only (open for the team, waiting on
 *    others, unclear), never a summary. The originals are the conversation
 *    beside it, and no catch-up is generated for it (useAnswerModeAssist).
 *    The web-team lane replaces this with the team stream.
 *
 * Read-only for now: the checkboxes are the items the reply should cover and
 * live in local state; the stance picker and the coverage chips from the
 * draft's response plan come with the drafting work. A file chip attaches the
 * file to the reply, as the catch-up card's did; a source marker reveals the
 * message it points at.
 */
import type { FileView } from '../../../../api/convex/mail/interpret/briefShape';
import type { AnswerLayout } from '~/utils/answerModeLayout';
import { useThreadBrief } from '~/composables/useThreadBrief';
import { resolveCite } from '~/utils/threadBriefItems';
import { threadFilesOf, type ThreadFile, type ThreadFileSource } from '~/utils/answerThreadFiles';
import type { BriefSource } from '~/utils/threadBriefContext';
import ThreadBrief from '~/components/brief/ThreadBrief.vue';
import BriefTeamActions from '~/components/brief/BriefTeamActions.vue';

export interface AnswerBriefMessage extends ThreadFileSource {
	fromName?: string | null;
	fromAddress: string;
}

const props = defineProps<{
	threadId?: string;
	/** The conversation view: the card only shows in Summary. */
	shown: 'summary' | 'full';
	layout: AnswerLayout;
	messages: readonly AnswerBriefMessage[];
	canAttach: boolean;
}>();

const emit = defineEmits<{ reveal: [messageId: string]; attach: [file: ThreadFile] }>();

const { view, brief } = useThreadBrief({ threadId: () => props.threadId });
const teamView = computed(() => (view.value?.mode === 'actions' ? view.value : null));

const selected = ref<string[]>([]);
watch(
	() => (teamView.value ? teamView.value.forTeam : brief.value?.forYou),
	(items) => {
		// Every open item for the reader starts selected ("Reply to all 4").
		if (selected.value.length === 0 && items) {
			selected.value = items.filter((i) => i.status === 'open').map((i) => i.id);
		}
	},
	{ immediate: true }
);

function sourceOf(messageId: string): BriefSource | undefined {
	const m = props.messages.find((x) => x._id === messageId);
	return m ? { name: m.fromName ?? undefined, email: m.fromAddress, at: m.receivedAt } : undefined;
}

function onCite(ref: string, quoteIndex: number) {
	const b = brief.value;
	if (b) {
		const target = resolveCite(b, { ref, quoteIndex });
		if (target) emit('reveal', target.messageId);
		return;
	}
	// Team view: items only.
	const item = [
		...(teamView.value?.forTeam ?? []),
		...(teamView.value?.waitingOnOthers ?? []),
		...(teamView.value?.unclear ?? []),
	].find((i) => i.id === ref);
	const source = item?.evidence[quoteIndex]?.source ?? item?.evidence[0]?.source;
	if (source) emit('reveal', source.id);
}

function onFile(file: FileView) {
	const match = threadFilesOf(props.messages).find(
		(f) => f.messageId === file.messageId && f.filename === file.filename
	);
	if (match && props.canAttach) emit('attach', match);
}
</script>

<template>
	<template v-if="shown === 'summary'">
		<BriefTeamActions
			v-if="teamView"
			v-model:selected="selected"
			:view="teamView"
			:source-of="sourceOf"
			@cite="onCite"
		/>
		<ThreadBrief
			v-else-if="brief && brief.completeness !== 'none'"
			v-model:selected="selected"
			:brief="brief"
			:source-of="sourceOf"
			selectable
			:compact="layout === 'phone'"
			:file-action="canAttach ? 'attach' : undefined"
			@cite="onCite"
			@select-file="onFile"
		/>
	</template>
</template>
