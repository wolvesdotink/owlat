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
 * The background clarification of a Reply Queue thread, above the editor:
 * the Reply Queue needs a fact from the owner before it can draft,
 * so no reply is prepared and the questions show first, as the same ask card
 * "Draft with AI" uses (chips, dates, files, remembered answers pre-picked with
 * "last time"). "Answer and draft" needs every question answered; "Draft with
 * what I have" drafts at once and leaves a highlighted gap for the rest. Both
 * go through the Reply Queue's own mutation; the card then waits for the
 * starter reply and hands it to the editor when it lands. Someone who started
 * writing while the reply was drafted keeps their text: the card then says the
 * draft is ready and puts it in only when asked.
 *
 * The thread comes from the Answer queue's current item, or, for a reply
 * opened elsewhere (Reply in the reader), from the thread's own prepared-reply
 * read. Renders nothing unless that thread carries a clarification still asking
 * or drafting. A reply that was already drafted when the page opened is the
 * prepared draft's business, not this card's.
 */
const props = defineProps<{
	messageId: string;
	/** The message's thread, for a reply opened outside the Answer queue. */
	threadId?: string;
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
	/** Whether the card shows questions to answer (not only a status line). */
	(e: 'asking', asking: boolean): void;
}>();

const { t } = useI18n();
const session = useAnswerQueueSession();

const queueRow = computed(() => {
	const item = session?.flow.current.value;
	if (!session?.isCurrentRoute.value || item?.source !== 'mail') return null;
	return item.row.messageId === props.messageId ? item.row : null;
});
// Outside the queue: the thread's own read (shared with the prepared draft's).
const prepared = useConvexQuery(api.mail.needsReplyPrepared.getPreparedDraft, () =>
	!queueRow.value && props.threadId
		? { threadId: props.threadId as Id<'mailThreads'> }
		: ('skip' as const)
);
const row = computed(() => {
	if (queueRow.value) return queueRow.value;
	const clarification = prepared.data.value?.clarification;
	return props.threadId && clarification ? { threadId: props.threadId, clarification } : null;
});
const state = computed(() => clarificationCardState(row.value?.clarification));
// The Reply Queue's questions carry the same clarification question shape the
// ask session does (lib/validators/clarification.ts).
const questions = computed(
	() => (row.value?.clarification?.questions ?? []) as unknown as AskQuestion[]
);
const deferred = ref(false);
/** A starter reply that landed after the person began writing, waiting to be asked for. */
const waitingDraft = ref<string | null>(null);
const visible = computed(
	() =>
		!!row.value &&
		!deferred.value &&
		(state.value === 'asking' ||
			state.value === 'drafting' ||
			state.value === 'held' ||
			state.value === 'paused' ||
			waitingDraft.value !== null)
);
watch(visible, (value) => emit('visible', value), { immediate: true });
const asking = computed(() => visible.value && state.value === 'asking');
watch(asking, (value) => emit('asking', value), { immediate: true });
onBeforeUnmount(() => {
	emit('visible', false);
	emit('asking', false);
});

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

// A kept draft stands only while it is still the server's: one withdrawn (the
// thread's AI reading was paused) or replaced since goes with it.
watch(
	() => row.value?.clarification?.draft,
	(draft) => {
		if (waitingDraft.value !== null && draft !== waitingDraft.value) waitingDraft.value = null;
	}
);

function useWaitingDraft() {
	const draft = waitingDraft.value;
	waitingDraft.value = null;
	// Checked against the server's draft as it is now, not as it was kept.
	if (draft && state.value === 'ready' && row.value?.clarification?.draft === draft) {
		emit('use-draft', draft);
	}
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
/** Send the answers; `withGaps` is "Draft with what I have". */
async function submit(answers: AskCardAnswer[], withGaps = false) {
	const current = row.value;
	if (!current || submitting.value) return;
	submitting.value = true;
	try {
		await answerOp.run({
			threadId: current.threadId as Id<'mailThreads'>,
			answers: backgroundAskAnswers(current.clarification?.questions ?? [], answers),
			...(withGaps ? { withGaps: true } : {}),
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
			@answer="submit"
			@skip="submit($event, true)"
		/>
		<div
			v-else-if="state === 'paused'"
			class="flex items-center gap-2 border-b border-border-subtle px-3 py-3 text-sm text-text-secondary"
			role="status"
			data-testid="answer-queue-ask-paused"
		>
			<Icon name="lucide:circle-pause" class="size-4 shrink-0" aria-hidden="true" />
			<span class="flex-1">{{ t('components.postbox.postboxClarificationCard.paused') }}</span>
			<UiButton variant="ghost" size="sm" @click="deferred = true">
				{{ t('components.postbox.postboxClarificationCard.answerLater') }}
			</UiButton>
		</div>
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
			v-else-if="state === 'held'"
			class="flex items-center gap-2 border-b border-border-subtle px-3 py-3 text-sm text-text-secondary"
			role="status"
			data-testid="answer-queue-ask-held"
		>
			<Icon name="lucide:shield-alert" class="size-4 shrink-0" aria-hidden="true" />
			<span class="flex-1">{{ t('components.postbox.postboxClarificationCard.held') }}</span>
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
