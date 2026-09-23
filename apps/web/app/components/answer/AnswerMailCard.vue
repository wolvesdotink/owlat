<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import TaskActions from '~/components/agent-tasks/TaskActions.vue';
import TaskAsk from '~/components/agent-tasks/TaskAsk.vue';
import TaskCardRenderer from '~/components/agent-tasks/TaskCardRenderer.vue';
import TaskCardShell from '~/components/agent-tasks/TaskCardShell.vue';
import TaskContext from '~/components/agent-tasks/TaskContext.vue';
import type { ReplyQuoteTarget } from '~/composables/postbox/usePostboxQuotedText';
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
 * One Postbox thread that needs a reply, as an Answer-queue card. All the
 * Reply Queue's actions survive — answer a clarification, review & send a
 * prepared draft, draft a reply, Done, Snooze, Archive, Open — and the reply
 * is always written from the inbox the mail came in to (`mailboxId`).
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

const { isEnabled: isFeatureEnabled } = useFeatureFlag();
const aiEnabled = computed(() => isFeatureEnabled('ai'));
const stack = usePostboxComposerStack();

const clearOp = useBackendOperation(api.mail.needsReply.clear, {
	label: () => t('components.postbox.postboxReplyFlow.operations.markDone'),
});
const cancelFollowUpOp = useBackendOperation(api.mail.followUps.cancel, {
	label: () => t('components.postbox.postboxReplyFlow.operations.dismissReminder'),
});
const archiveOp = useBackendOperation(api.mail.messageActions.archive, {
	label: () => t('components.postbox.postboxReplyFlow.operations.archive'),
});
const moveOp = useBackendOperation(api.mail.messageActions.move, {
	label: () => t('components.postbox.postboxReplyFlow.operations.move'),
});
const snoozeOp = useBackendOperation(api.mail.snooze.snooze, {
	label: () => t('components.postbox.postboxReplyFlow.operations.snooze'),
});
const suggestOp = useBackendOperation(api.mail.ai.assist.suggestReplies, {
	label: () => t('components.postbox.postboxReplyFlow.operations.draftReply'),
	type: 'action',
});
const answerOp = useBackendOperation(api.mail.ai.needsReplyClarify.answerClarification, {
	label: () => t('components.postbox.postboxReplyFlow.operations.answer'),
});

const busy = ref(false);

async function submitClarification(answers: { questionId: string; value: string }[]) {
	if (busy.value) return;
	busy.value = true;
	try {
		await answerOp.run({ threadId: props.row.threadId as Id<'mailThreads'>, answers });
		props.controls.complete('answered');
	} finally {
		busy.value = false;
	}
}

/** Open the composer prefilled with a draft, replying from the card's inbox. */
async function openReplyComposer(bodyText: string) {
	const messageId = props.row.messageId as Id<'mailMessages'>;
	let target: ReplyQuoteTarget = { ...props.row, _id: props.row.messageId };
	try {
		const message = await requireConvex().query(api.mail.mailbox.messages.getMessage, {
			messageId,
		});
		if (message) target = message;
		target = await resolveBodyFields(target);
	} catch {
		// Fall through with the queue row's fields — the composer still opens.
	}
	stack.open(buildReplySpec(props.mailboxId, target, bodyText));
}

async function openClarificationDraft(draft: string) {
	await openReplyComposer(draft);
	props.controls.complete('answered');
}
async function reviewSlot(draft: string) {
	await openReplyComposer(draft);
	props.controls.complete('replied');
}
async function draftReply() {
	if (busy.value) return;
	busy.value = true;
	try {
		let suggestion = '';
		if (aiEnabled.value) {
			const res = await suggestOp.run({ messageId: props.row.messageId as Id<'mailMessages'> });
			suggestion = res.ok ? (res.result.replies[0] ?? '') : '';
		}
		await openReplyComposer(suggestion);
		props.controls.complete('replied');
	} finally {
		busy.value = false;
	}
}
async function markDone() {
	const threadId = props.row.threadId as Id<'mailThreads'>;
	const result =
		props.row.kind === 'followup'
			? await cancelFollowUpOp.run({ threadId })
			: await clearOp.run({ threadId });
	if (result.ok) props.controls.complete('cleared');
}
async function archiveRow() {
	const result = await archiveOp.run({ messageIds: [props.row.messageId as Id<'mailMessages'>] });
	if (!result.ok || result.result == null || !('moved' in result.result)) return;
	const moved = result.result.moved;
	props.controls.complete('archived', async () => {
		for (const m of moved) {
			await moveOp.run({ messageIds: [m.messageId], targetFolderId: m.sourceFolderId });
		}
	});
}

const snoozeOpen = ref(false);
async function confirmSnooze(until: number) {
	const result = await snoozeOp.run({
		messageId: props.row.messageId as Id<'mailMessages'>,
		until,
	});
	if (result.ok) props.controls.complete('snoozed');
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
	if (action === 'markDone') void markDone();
	else if (action === 'draftReply') void draftReply();
	else if (action === 'archive') void archiveRow();
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
		@open-draft="openClarificationDraft"
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
			v-if="row.kind !== 'followup' && row.draftSlot"
			class="mb-4"
			:draft-slot="row.draftSlot"
			@review="reviewSlot"
			@dismiss="markDone"
		/>

		<TaskActions
			v-if="row.kind !== 'followup'"
			:primary-label="
				row.draftSlot
					? t('components.answer.mail.writeOwn')
					: aiEnabled
						? t('components.postbox.postboxReplyFlow.draftReply')
						: t('components.postbox.postboxReplyFlow.reply')
			"
			:quiet="!!row.draftSlot"
			primary-icon="lucide:reply"
			:primary-disabled="busy"
			:primary-loading="busy"
			:skip-label="t('common.done')"
			:hints="[
				{ keys: ['Enter'], label: t('components.postbox.postboxReplyFlow.reply') },
				{ keys: ['e'], label: t('common.archive') },
				{ keys: ['←', '→'], label: t('components.postbox.postboxReplyFlow.browse') },
			]"
			@primary="draftReply"
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
