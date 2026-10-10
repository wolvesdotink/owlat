<script setup lang="ts">
/**
 * Answer mode's view of the thread being answered (SPEC §7):
 *
 *  - a personal mailbox: the thread brief with selectable items;
 *  - a shared (team) mailbox: the actions only (open for the team, waiting on
 *    others, unclear), never a summary. The originals are the conversation
 *    beside it.
 *
 * With the reply's response plan (`plan`, SPEC §6) the checkboxes are the
 * plan's selection (an unchecked item is skipped), each selected item has its
 * stance picker, and the draft's coverage marks it "Addressed in draft" or
 * "File missing" (provided to the items as `RESPONSE_PLAN`). Without a plan
 * the selection is local. A file chip attaches the file to the reply; a source
 * marker reveals the message it points at.
 */
import type { FileView } from '../../../../api/convex/mail/interpret/briefShape';
import type { AnswerLayout } from '~/utils/answerModeLayout';
import { useThreadBrief } from '~/composables/useThreadBrief';
import { resolveCite } from '~/utils/threadBriefItems';
import { threadFilesOf, type ThreadFile, type ThreadFileSource } from '~/utils/answerThreadFiles';
import type { BriefSource } from '~/utils/threadBriefContext';
import { provide } from 'vue';
import { RESPONSE_PLAN } from '~/utils/responsePlan';
import type { ResponsePlan } from '~/composables/useResponsePlan';
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
	/** The reply's response plan (Answer mode drafting). */
	plan?: ResponsePlan;
}>();

const emit = defineEmits<{ reveal: [messageId: string]; attach: [file: ThreadFile] }>();

const { view, brief, itemsState, isClosedTruncated } = useThreadBrief({
	threadId: () => props.threadId,
});
const teamView = computed(() => (view.value?.mode === 'actions' ? view.value : null));

if (props.plan) provide(RESPONSE_PLAN, props.plan.view);

const localSelected = ref<string[]>([]);
watch(
	() => (teamView.value ? teamView.value.forTeam : brief.value?.forYou),
	(items) => {
		// Every open item for the reader starts selected ("Reply to all 4").
		if (localSelected.value.length === 0 && items) {
			localSelected.value = items.filter((i) => i.status === 'open').map((i) => i.id);
		}
	},
	{ immediate: true }
);
const selected = computed({
	get: () => props.plan?.selected.value ?? localSelected.value,
	set: (ids: string[]) => {
		if (props.plan) props.plan.setSelected(ids);
		else localSelected.value = ids;
	},
});

function sourceOf(messageId: string): BriefSource | undefined {
	const m = props.messages.find((x) => x._id === messageId);
	return m ? { name: m.fromName ?? undefined, email: m.fromAddress, at: m.receivedAt } : undefined;
}

function onCite(ref: string, quoteIndex: number) {
	// One resolver for both modes: items, pending changes (`<id>~pending`),
	// facts and latest lines (utils/threadBriefItems resolveCite).
	const v = brief.value ?? teamView.value;
	const target = v ? resolveCite(v, { ref, quoteIndex }) : null;
	if (target) emit('reveal', target.messageId);
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
			:items-state="itemsState"
			:is-closed-truncated="isClosedTruncated"
			@cite="onCite"
			@select-file="onFile"
		/>
	</template>
</template>
