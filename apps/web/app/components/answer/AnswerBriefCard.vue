<script setup lang="ts">
/**
 * Answer mode's view of the thread being answered (SPEC §7): the thread brief
 * with selectable items, in place of the catch-up card.
 *
 * Read-only for now: the checkboxes are the items the reply should cover and
 * live in local state (`v-model:selected` on ThreadBrief); the stance picker
 * and the coverage chips from the draft's response plan come with the
 * drafting work. A file chip attaches the file to the reply, as the catch-up
 * card's did; a source marker reveals the message it points at.
 *
 * A shared (team) mailbox has no brief: it keeps the catch-up card until the
 * team stream replaces it.
 */
import type { FileView } from '../../../../api/convex/mail/interpret/briefShape';
import type { CatchUp } from '~/composables/useAnswerCatchUp';
import type { AnswerLayout } from '~/utils/answerModeLayout';
import { useThreadBrief } from '~/composables/useThreadBrief';
import { resolveCite } from '~/utils/threadBriefItems';
import { threadFilesOf, type ThreadFile } from '~/utils/answerThreadFiles';
import type { BriefSource } from '~/utils/threadBriefContext';
import ThreadBrief from '~/components/brief/ThreadBrief.vue';
import CatchUpCard, { type CatchUpMessage } from './CatchUpCard.vue';

const props = defineProps<{
	mailboxId: string;
	threadId?: string;
	/** The conversation view: the catch-up card only shows in Summary. */
	shown: 'summary' | 'full';
	layout: AnswerLayout;
	messages: readonly CatchUpMessage[];
	catchUp: CatchUp | null;
	loading: boolean;
	covered: readonly string[];
	attaching: string | null;
	canAttach: boolean;
}>();

const emit = defineEmits<{ reveal: [messageId: string]; attach: [file: ThreadFile] }>();

const { byId } = useInboxes();
const isShared = computed(() => byId.value.get(props.mailboxId as never)?.scope === 'shared');
const { brief } = useThreadBrief({ threadId: () => (isShared.value ? null : props.threadId) });

const selected = ref<string[]>([]);
watch(
	() => brief.value?.forYou,
	(items) => {
		// Every open for-you item starts selected ("Reply to all 4").
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
	const target = brief.value ? resolveCite(brief.value, { ref, quoteIndex }) : null;
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
	<CatchUpCard
		v-if="isShared && shown === 'summary'"
		:collapsible="layout === 'phone'"
		:catch-up="catchUp"
		:loading="loading"
		:messages="messages"
		:covered="covered"
		:attaching="attaching"
		:can-attach="canAttach"
		@reveal="emit('reveal', $event)"
		@attach="emit('attach', $event)"
	/>
	<ThreadBrief
		v-else-if="!isShared && brief !== null && brief?.completeness !== 'none'"
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
