<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { useAnswerQueueSession } from '~/composables/useAnswerQueueSession';
import { useAnswerMailActions } from '~/composables/useAnswerMailActions';
import { clarificationCardState } from '~/utils/postboxReplyQueue';
import type { ClarificationAnswer } from '~/utils/clarificationAnswers';

/**
 * The background clarification of an Answer queue item, above the editor
 * (plan §07): the Reply Queue asked the owner something before it could draft,
 * and an item waiting on that answer shows the questions first. Answering goes
 * through the same mutation the queue card used (remembered answers go back
 * as `memory`), the card then waits for the starter reply, and "I'll answer
 * later" puts it away so the person can simply write.
 *
 * Renders nothing unless the page is the queue's current item and that item
 * carries a clarification.
 */
const props = defineProps<{ messageId: string }>();
const emit = defineEmits<{
	/** The starter reply written from the answers, for the editor. */
	(e: 'use-draft', draft: string): void;
}>();

const { t } = useI18n();
const session = useAnswerQueueSession();

const row = computed(() => {
	const item = session?.flow.current.value;
	if (!session?.isCurrentRoute.value || item?.source !== 'mail') return null;
	return item.row.messageId === props.messageId ? item.row : null;
});
const state = computed(() => clarificationCardState(row.value?.clarification));

// "I'll answer later": the questions stay on the thread; only this page stops
// showing them.
const deferred = ref(false);
const visible = computed(() => !!row.value && state.value !== null && !deferred.value);

const answerOp = useBackendOperation(api.mail.ai.needsReplyClarify.answerClarification, {
	label: () => t('components.postbox.postboxReplyFlow.operations.answer'),
});
const submitting = ref(false);
async function submit(answers: ClarificationAnswer[]) {
	const current = row.value;
	if (!current || submitting.value) return;
	submitting.value = true;
	try {
		await answerOp.run({
			threadId: current.threadId as Id<'mailThreads'>,
			answers: answers.map(({ questionId, value, source }) => ({ questionId, value, source })),
		});
	} finally {
		submitting.value = false;
	}
}

const mail = useAnswerMailActions(
	() => row.value,
	() => session
);
</script>

<template>
	<div v-if="visible && row" class="px-4 pt-3" data-testid="answer-queue-ask">
		<PostboxClarificationCard
			:item="row"
			:submitting="submitting"
			@answer="submit"
			@open-draft="emit('use-draft', $event)"
			@done="mail.markDone()"
			@defer="deferred = true"
		/>
	</div>
</template>
