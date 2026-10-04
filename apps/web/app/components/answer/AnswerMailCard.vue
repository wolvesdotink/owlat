<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import TaskActions from '~/components/agent-tasks/TaskActions.vue';
import TaskAsk from '~/components/agent-tasks/TaskAsk.vue';
import TaskCardShell from '~/components/agent-tasks/TaskCardShell.vue';
import TaskContext from '~/components/agent-tasks/TaskContext.vue';
import { useAnswerMailActions } from '~/composables/useAnswerMailActions';
import { useLocalized } from '~/composables/useLocalized';
import { resolveReplyFocusKey } from '~/utils/taskFlowKeyboard';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import type { AnswerCardControls } from '~/utils/answerCard';
import {
	replyQueueHeadline,
	formatReplyQueueDueHint,
	type ReplyQueueItem,
} from '~/utils/postboxReplyQueue';

/**
 * A Postbox follow-up reminder as an Answer-queue card: we are waiting on
 * them, so its one verb is Done (dismiss the reminder). Reply writes a nudge
 * in Answer mode, from the inbox the mail is in (`mailboxId`); Open shows the
 * thread.
 *
 * This is the only mail row the queue shows as a card. Every other row opens
 * in Answer mode (`opensInAnswerMode`), where a prepared draft is in the
 * editor and a clarification's questions are in the ask card, so the card
 * carries neither (#1188).
 *
 * Replying never finishes the card by itself: Answer mode finishes the item
 * when the reply is sent.
 *
 * Keyboard on the focused card: Enter = Done, ←/→ browse. Inert while typing.
 */
const props = defineProps<{
	row: ReplyQueueItem;
	mailboxId: Id<'mailboxes'>;
	controls: AnswerCardControls;
}>();

const { t, locale } = useI18n();

const replyQueueText = useLocalized();
const headline = computed(() => replyQueueText(replyQueueHeadline(props.row)));
const dueLabel = computed(() => {
	const due = formatReplyQueueDueHint(props.row.dueHint, locale.value);
	return due === null ? undefined : replyQueueText(due);
});

const mail = useAnswerMailActions(
	() => props.row,
	() => props.controls
);

/** Write a nudge in Answer mode. The queue keeps the item until it is sent. */
function answerInAnswerMode() {
	props.controls.openAnswer();
}
function markDone() {
	void mail.markDone();
}

function openRow() {
	void navigateTo(`/dashboard/postbox/inbox/${props.row.messageId}?mailbox=${props.mailboxId}`);
}

function onKeydown(event: KeyboardEvent) {
	if (event.metaKey || event.ctrlKey || event.altKey) return;
	if (isEditableTarget(event.target)) return;
	const action = resolveReplyFocusKey(event.key, { currentKind: 'reply', isFollowup: true });
	if (action === 'markDone') markDone();
	else if (action === 'browseBack') props.controls.back();
	else if (action === 'browseNext') props.controls.next();
	else return;
	event.preventDefault();
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

const secondaryButton =
	'inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors duration-(--motion-fast)';
</script>

<template>
	<TaskCardShell>
		<TaskContext
			:who="row.fromName || row.fromAddress"
			:name="row.fromName"
			:email="row.fromAddress"
			:due="dueLabel"
			:meta="formatCompactRelativeTime(row.receivedAt)"
		>
			<template #chips>
				<span
					class="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide px-1.5 py-px rounded-full bg-brand/10 text-brand"
				>
					<Icon name="lucide:alarm-clock" class="w-3 h-3" />
					{{ t('components.postbox.postboxReplyFlow.followUp') }}
				</span>
			</template>
		</TaskContext>

		<TaskAsk class="mt-3 mb-4" :ask="headline" :detail="row.snippet" />

		<TaskActions :primary-label="t('common.done')" primary-icon="lucide:check" @primary="markDone">
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
</template>
