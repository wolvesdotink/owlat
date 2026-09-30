<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import AskCard from '~/components/answer/AskCard.vue';
import type { FileAnswerRef } from '~/components/answer/FileAsk.vue';
import type { AskAnswer, AskQuestion } from '~/composables/useAnswerAskSession';
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
 * simply write.
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

const deferred = ref(false);
const visible = computed(
	() => !!row.value && !deferred.value && (state.value === 'asking' || state.value === 'drafting')
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
			emit('use-draft', draft);
		}
	},
	{ immediate: true }
);

const answerOp = useBackendOperation(api.mail.ai.needsReplyClarify.answerClarification, {
	label: () => t('components.postbox.postboxReplyFlow.operations.answer'),
});
const submitting = ref(false);
async function submit(answers: AskAnswer[]) {
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
			:questions="questions"
			:submitting="submitting"
			:mailbox-id="mailboxId"
			:resolve-thread-file="resolveThreadFile"
			:skip-label="t('components.postbox.postboxClarificationCard.answerLater')"
			@answer="submit"
			@skip="deferred = true"
		/>
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
