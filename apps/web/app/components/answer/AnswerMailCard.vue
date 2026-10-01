<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import TaskActions from '~/components/agent-tasks/TaskActions.vue';
import TaskAsk from '~/components/agent-tasks/TaskAsk.vue';
import TaskCardRenderer from '~/components/agent-tasks/TaskCardRenderer.vue';
import TaskCardShell from '~/components/agent-tasks/TaskCardShell.vue';
import TaskContext from '~/components/agent-tasks/TaskContext.vue';
import type { ClarificationAnswer } from '~/utils/clarificationAnswers';
import { useAnswerMailActions } from '~/composables/useAnswerMailActions';
import { isBuiltInTaskFlowKind } from '~/utils/taskCardRegistry';
import { resolveReplyFocusKey } from '~/utils/taskFlowKeyboard';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import { mailAnswerKind, type AnswerCardControls } from '~/utils/answerCard';
import {
	replyQueueHeadline,
	formatReplyQueueDueHint,
	replyQueueSection,
	type ReplyQueueItem,
	type ReplyQueueText,
} from '~/utils/postboxReplyQueue';

/**
 * One Postbox thread that needs a reply, as an Answer-queue card. The queue
 * opens most of these in Answer mode directly; the card is what shows for a
 * follow-up reminder, and wherever else the queue page keeps an item as a card.
 * Its verbs: answer a clarification, review a prepared draft or write the
 * reply (all in Answer mode), Done, Snooze, Archive, Open. The reply is always
 * written from the inbox the mail came in to (`mailboxId`).
 *
 * Replying never finishes the card by itself: Answer mode finishes the item
 * when the reply is sent. (The card used to complete as the composer opened,
 * so closing the popup without sending dropped the email from the queue.)
 *
 * Keyboard on the focused card: Enter = reply (or Done for a follow-up),
 * e = archive, ←/→ browse, s = skip. Inert while typing.
 */
const props = defineProps<{
	row: ReplyQueueItem;
	mailboxId: Id<'mailboxes'>;
	controls: AnswerCardControls;
}>();

const { t, locale } = useI18n();

function replyQueueText(value: ReplyQueueText): string {
	return typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});
}
const headline = computed(() => replyQueueText(replyQueueHeadline(props.row)));
const dueLabel = computed(() => {
	const due = formatReplyQueueDueHint(props.row.dueHint, locale.value);
	return due === null ? undefined : replyQueueText(due);
});
const kind = computed(() => mailAnswerKind(props.row));

// The prepared draft is read for the card on screen only; the queue rows just
// say one exists (plan C8).
const { data: draftSlot } = useConvexQuery(api.mail.needsReply.getDraftSlot, () =>
	props.row.kind !== 'followup' && props.row.hasDraftSlot
		? { threadId: props.row.threadId as Id<'mailThreads'> }
		: 'skip'
);

const { isEnabled: isFeatureEnabled } = useFeatureFlag();
const aiEnabled = computed(() => isFeatureEnabled('ai'));

const mail = useAnswerMailActions(
	() => props.row,
	() => props.controls
);
const answerOp = useBackendOperation(api.mail.ai.needsReplyClarify.answerClarification, {
	label: () => t('components.postbox.postboxReplyFlow.operations.answer'),
});

const busy = ref(false);

async function submitClarification(answers: ClarificationAnswer[]) {
	if (busy.value) return;
	busy.value = true;
	try {
		await answerOp.run({
			threadId: props.row.threadId as Id<'mailThreads'>,
			answers: answers.map(({ questionId, value, source }) => ({ questionId, value, source })),
		});
		// Answering is not replying: the card stays, flips to the starter reply,
		// and that opens in Answer mode.
	} finally {
		busy.value = false;
	}
}

/**
 * Write the reply in Answer mode: a prepared draft or a clarification's
 * starter reply opens there in the editor. The queue keeps the item until the
 * reply is sent.
 */
function answerInAnswerMode() {
	props.controls.openAnswer();
}
function markDone() {
	void mail.markDone();
}
function archiveRow() {
	void mail.archive();
}

const snoozeOpen = ref(false);
function confirmSnooze(until: number) {
	void mail.snooze(until);
}

function openRow() {
	void navigateTo(`/dashboard/postbox/inbox/${props.row.messageId}?mailbox=${props.mailboxId}`);
}

function onKeydown(event: KeyboardEvent) {
	if (event.metaKey || event.ctrlKey || event.altKey) return;
	if (isEditableTarget(event.target) || snoozeOpen.value) return;
	const action = resolveReplyFocusKey(event.key, {
		currentKind: kind.value,
		isFollowup: props.row.kind === 'followup',
	});
	if (!action) return;
	event.preventDefault();
	if (action === 'markDone') markDone();
	else if (action === 'draftReply') answerInAnswerMode();
	else if (action === 'archive') archiveRow();
	else if (action === 'browseBack') props.controls.back();
	else if (action === 'browseNext') props.controls.next();
	else props.controls.skip();
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

const URGENCY_LABEL_KEYS: Record<string, string> = {
	high: 'components.postbox.postboxReplyFlow.urgency.high',
	low: 'components.postbox.postboxReplyFlow.urgency.low',
};
const urgencyLabel = computed(() => {
	const key = URGENCY_LABEL_KEYS[props.row.urgency];
	return key ? t(key) : '';
});
const secondaryButton =
	'inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors duration-(--motion-fast)';
</script>

<template>
	<!-- Needs-your-input clarification -->
	<PostboxClarificationCard
		v-if="isBuiltInTaskFlowKind(kind) && replyQueueSection(row) === 'needs_input'"
		:item="row"
		:submitting="busy"
		@answer="submitClarification"
		@open-draft="answerInAnswerMode"
		@open="openRow"
		@done="markDone"
		@defer="controls.skip()"
	/>

	<!-- Plain needs-you / follow-up / draft-review card -->
	<TaskCardShell v-else-if="isBuiltInTaskFlowKind(kind)">
		<TaskContext
			:who="row.fromName || row.fromAddress"
			:name="row.fromName"
			:email="row.fromAddress"
			:due="dueLabel"
			:meta="formatCompactRelativeTime(row.receivedAt)"
		>
			<template #chips>
				<span
					v-if="row.kind === 'followup'"
					class="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide px-1.5 py-px rounded-full bg-brand/10 text-brand"
				>
					<Icon name="lucide:alarm-clock" class="w-3 h-3" />
					{{ t('components.postbox.postboxReplyFlow.followUp') }}
				</span>
				<span
					v-else-if="row.urgency !== 'normal'"
					class="text-[10px] font-medium uppercase tracking-wide px-1.5 py-px rounded-full"
					:class="
						row.urgency === 'high' ? 'bg-error/10 text-error' : 'bg-bg-elevated text-text-tertiary'
					"
					>{{ urgencyLabel }}</span
				>
			</template>
		</TaskContext>

		<TaskAsk class="mt-3 mb-4" :ask="headline" :detail="row.snippet" />

		<!-- Draft-on-arrival review slot (human review only). -->
		<PostboxReviewSlot
			v-if="row.kind !== 'followup' && draftSlot"
			class="mb-4"
			:draft-slot="draftSlot"
			@review="answerInAnswerMode"
			@dismiss="markDone"
		/>

		<TaskActions
			v-if="row.kind !== 'followup'"
			:primary-label="
				row.hasDraftSlot
					? t('components.answer.mail.writeOwn')
					: aiEnabled
						? t('components.postbox.postboxReplyFlow.draftReply')
						: t('components.postbox.postboxReplyFlow.reply')
			"
			:quiet="!!row.hasDraftSlot"
			primary-icon="lucide:reply"
			:primary-disabled="busy"
			:primary-loading="busy"
			:skip-label="t('common.done')"
			:hints="[{ keys: ['Enter'], label: t('components.postbox.postboxReplyFlow.reply') }]"
			@primary="answerInAnswerMode"
			@skip="markDone"
		>
			<button type="button" :class="secondaryButton" @click="snoozeOpen = true">
				<Icon name="lucide:clock" class="w-3.5 h-3.5" />
				{{ t('components.postbox.postboxReplyFlow.snooze') }}
			</button>
			<button type="button" :class="secondaryButton" @click="archiveRow">
				<Icon name="lucide:archive" class="w-3.5 h-3.5" />
				{{ t('common.archive') }}
			</button>
			<button type="button" :class="secondaryButton" @click="openRow">
				<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
				{{ t('common.open') }}
			</button>
		</TaskActions>

		<!-- Follow-up: we're waiting on THEM — Done dismisses the reminder. -->
		<TaskActions
			v-else
			:primary-label="t('common.done')"
			primary-icon="lucide:check"
			:primary-disabled="busy"
			@primary="markDone"
		>
			<button
				type="button"
				:class="secondaryButton"
				data-testid="answer-mail-nudge"
				@click="answerInAnswerMode"
			>
				<Icon name="lucide:reply" class="w-3.5 h-3.5" />
				{{ t('components.postbox.postboxReplyFlow.reply') }}
			</button>
			<button type="button" :class="secondaryButton" @click="openRow">
				<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
				{{ t('common.open') }}
			</button>
		</TaskActions>
	</TaskCardShell>

	<!-- Unknown/disabled or plugin-contributed kind: never crash, never drop it. -->
	<TaskCardRenderer
		v-else
		:kind="kind"
		:item="row"
		:is-flag-enabled="isFeatureEnabled"
		:can-open="true"
		@skip="controls.skip()"
		@open="openRow"
		@complete="(outcome) => controls.complete(outcome ?? 'completed')"
	/>

	<PostboxSnoozeDialog
		:open="snoozeOpen"
		@update:open="snoozeOpen = $event"
		@confirm="confirmSnooze"
	/>
</template>
