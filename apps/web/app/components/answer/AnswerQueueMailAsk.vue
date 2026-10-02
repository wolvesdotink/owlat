<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import AskCard, { type AskCardAnswer } from '~/components/answer/AskCard.vue';
import type { FileAnswerRef, FileCopyPolicy } from '~/components/answer/FileAsk.vue';
import type { AskQuestion } from '~/composables/useAnswerAskSession';
import { useAnswerQueueSession } from '~/composables/useAnswerQueueSession';
import { backgroundAskAnswers } from '~/utils/backgroundAskAnswers';
import { clarificationCardState } from '~/utils/postboxReplyQueue';
import type { ThreadFile } from '~/utils/answerThreadFiles';

/**
 * The background clarification of an Answer queue item, above the editor
 * (plan §07): the Reply Queue asked the owner something before it could draft,
 * and an item waiting on that answer shows the questions first, as the same
 * ask card "Draft with AI" uses (chips, dates, files, remembered answers
 * pre-picked with "last time"). Answering goes through the Reply Queue's own
 * mutation; the card then waits for the starter reply and hands it to the
 * editor when it lands. "Answer later" puts the card away so the person can
 * simply write. Someone who started writing while the reply was drafted keeps
 * their text: the card then says the draft is ready and puts it in only when
 * asked. An item whose reply was drafted on arrival asks only for what that
 * draft left open, and the card says so.
 *
 * Renders nothing unless the page is the queue's current item and that item
 * carries a clarification still asking or drafting. A reply that was already
 * drafted when the page opened is the prepared draft's business, not this
 * card's.
 */
const props = defineProps<{
	messageId: string;
	mailboxId?: Id<'mailboxes'>;
	resolveThreadFile?: (file: ThreadFile) => Promise<FileAnswerRef | null>;
	/** The person has written something in the reply. */
	written?: boolean;
	/** Whether an uploaded file answer is kept in Files (see FileAsk). */
	copyPolicy?: FileCopyPolicy;
}>();
const emit = defineEmits<{
	/** The starter reply written from the answers, for the editor. */
	(e: 'use-draft', draft: string): void;
	/** Whether the card is up (the page holds "Draft with AI" back meanwhile). */
	(e: 'visible', visible: boolean): void;
}>();

const { t } = useI18n();
const session = useAnswerQueueSession();

const row = computed(() => {
	const item = session?.flow.current.value;
	if (!session?.isCurrentRoute.value || item?.source !== 'mail') return null;
	return item.row.messageId === props.messageId ? item.row : null;
});
const state = computed(() => clarificationCardState(row.value?.clarification));
// The Reply Queue's questions carry the same clarification question shape the
// ask session does (lib/validators/clarification.ts).
const questions = computed(
	() => (row.value?.clarification?.questions ?? []) as unknown as AskQuestion[]
);
// Draft-on-arrival already wrote the reply and left a placeholder where the
// files go: the card only waits for them (issue #1131).
const waitingForFiles = computed(() => {
	const open = questions.value.filter((q) => !q.answer);
	return (
		!!row.value?.hasDraftSlot &&
		open.length > 0 &&
		open.every((q) => (q.answerKind ?? (q.slotType === 'attachment' ? 'file' : '')) === 'file')
	);
});

const deferred = ref(false);
/** A starter reply that landed after the person began writing, waiting to be asked for. */
const waitingDraft = ref<string | null>(null);
const visible = computed(
	() =>
		!!row.value &&
		!deferred.value &&
		(state.value === 'asking' || state.value === 'drafting' || waitingDraft.value !== null)
);
watch(visible, (value) => emit('visible', value), { immediate: true });
onBeforeUnmount(() => emit('visible', false));

// The starter reply lands while the page is open: into the editor, once.
let sawDrafting = false;
watch(
	state,
	(next) => {
		if (next === 'asking' || next === 'drafting') sawDrafting = true;
		const draft = row.value?.clarification?.draft;
		if (next === 'ready' && sawDrafting && !deferred.value && draft) {
			sawDrafting = false;
			if (props.written) waitingDraft.value = draft;
			else emit('use-draft', draft);
		}
	},
	{ immediate: true }
);

function useWaitingDraft() {
	const draft = waitingDraft.value;
	waitingDraft.value = null;
	if (draft) emit('use-draft', draft);
}

const askCardRef = ref<InstanceType<typeof AskCard> | null>(null);
/** Focus the first open question (the page's "Answer the questions…" row); false when none is up. */
function focusQuestion(): boolean {
	return askCardRef.value?.focusFirstOpen() ?? false;
}
defineExpose({ focusQuestion });

const answerOp = useBackendOperation(api.mail.ai.needsReplyClarify.answerClarification, {
	label: () => t('components.postbox.postboxReplyFlow.operations.answer'),
});
const submitting = ref(false);
async function submit(answers: AskCardAnswer[]) {
	const current = row.value;
	if (!current || submitting.value) return;
	submitting.value = true;
	try {
		await answerOp.run({
			threadId: current.threadId as Id<'mailThreads'>,
			answers: backgroundAskAnswers(current.clarification?.questions ?? [], answers),
		});
	} finally {
		submitting.value = false;
	}
}
</script>

<template>
	<div v-if="visible && row" data-testid="answer-queue-ask">
		<AskCard
			v-if="state === 'asking'"
			ref="askCardRef"
			:questions="questions"
			:submitting="submitting"
			:mailbox-id="mailboxId"
			:resolve-thread-file="resolveThreadFile"
			:copy-policy="copyPolicy"
			multiple-files
			:waiting-for-files="waitingForFiles"
			:draft-written="!!row.hasDraftSlot"
			:skip-label="t('components.postbox.postboxClarificationCard.answerLater')"
			@answer="submit"
			@skip="deferred = true"
		/>
		<div
			v-else-if="waitingDraft !== null"
			class="flex items-center gap-2 border-b border-border-subtle px-3 py-3 text-sm text-text-secondary"
			role="status"
			data-testid="answer-queue-ask-ready"
		>
			<Icon name="lucide:sparkles" class="size-4 text-brand" aria-hidden="true" />
			<span class="flex-1">{{ t('components.answer.aiBar.readyKept') }}</span>
			<UiButton variant="secondary" size="sm" @click="useWaitingDraft">
				{{ t('components.answer.aiBar.useDraft') }}
			</UiButton>
			<UiButton variant="ghost" size="sm" @click="deferred = true">
				{{ t('components.answer.aiBar.discard') }}
			</UiButton>
		</div>
		<div
			v-else
			class="flex items-center gap-2 border-b border-border-subtle px-3 py-3 text-sm text-text-secondary"
			role="status"
			data-testid="answer-queue-ask-drafting"
		>
			<Icon
				name="lucide:loader-2"
				class="size-4 animate-spin motion-reduce:animate-none"
				aria-hidden="true"
			/>
			<span class="flex-1">{{ t('components.postbox.postboxClarificationCard.drafting') }}</span>
			<UiButton variant="ghost" size="sm" @click="deferred = true">
				{{ t('components.postbox.postboxClarificationCard.answerLater') }}
			</UiButton>
		</div>
	</div>
</template>
