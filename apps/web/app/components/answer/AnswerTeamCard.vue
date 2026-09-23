<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';
import TaskActions from '~/components/agent-tasks/TaskActions.vue';
import TaskAsk from '~/components/agent-tasks/TaskAsk.vue';
import TaskCardShell from '~/components/agent-tasks/TaskCardShell.vue';
import TaskContext from '~/components/agent-tasks/TaskContext.vue';
import { resolveReviewFocusKey } from '~/utils/taskFlowKeyboard';
import { useOrganization } from '~/composables/useOrganization';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import {
	GENERIC_TEAMMATE_NAME,
	isReplyCollision,
	replyCollisionToast,
	sendHoldReason,
} from '~/utils/replyCollision';
import { escalationTrustLabel, trustLabel, type TrustLabel } from '~/utils/trustLabel';
import type { AnswerCardControls } from '~/utils/answerCard';

type ReviewEntry = FunctionReturnType<typeof api.inbox.queries.getReviewQueue>[number];

/**
 * A team-inbox item as an Answer-queue card: an agent draft waiting for
 * approval (Approve & send / Reject), or a draftless escalation the reviewer
 * answers inline. Everything the team Review Queue did survives — the
 * countdown undo on approve, the soft hold while a teammate is replying, the
 * honest "already handled" when someone got there first.
 *
 * Keyboard on the focused card: a = approve, x = reject, Enter = the primary
 * action, s = skip. Inert while typing.
 */
const props = defineProps<{ entry: ReviewEntry; controls: AnswerCardControls }>();

const { t } = useI18n();

type CollisionMessage = string | { key: string; params?: Record<string, unknown> };
function collisionText(message: CollisionMessage): string {
	return typeof message === 'string' ? t(message) : t(message.key, message.params ?? {});
}

const { needsReply, onApprove, approveOption, onReject, undoApprove, composeAndSend } =
	useReviewQueue();
const message = computed(() => props.entry.message);
const draftless = computed(() => needsReply(message.value));

// Collision soft-hold: while ANOTHER teammate is actively replying to this
// thread, hold the send/approve button (visible, disabled-styled). The server
// re-checks at send time.
const { user } = useAuth();
const { members, fetchMembers } = useOrganization();
onMounted(() => void fetchMembers());
const threadId = computed<Id<'conversationThreads'> | null>(() => props.entry.thread?._id ?? null);
const { data: presenceData } = useConvexQuery(api.inbox.presence.list, () =>
	threadId.value ? { threadId: threadId.value } : 'skip'
);
const heldReplier = computed(() => {
	const uid = user.value?.id;
	return (presenceData.value ?? []).find((r) => r.mode === 'replying' && r.userId !== uid) ?? null;
});
const isHeld = computed(() => heldReplier.value !== null);
const heldReason = computed(() => {
	if (!heldReplier.value) return undefined;
	const m = members.value.find((x) => x.userId === heldReplier.value!.userId);
	const name = m ? m.user.name || m.user.email : t(GENERIC_TEAMMATE_NAME);
	return collisionText(sendHoldReason(name));
});

const { showToast } = useToast();
const busy = ref(false);
const composeBody = ref('');

const trust = computed<TrustLabel>(() =>
	draftless.value
		? escalationTrustLabel()
		: trustLabel(
				message.value.draftQuality ? message.value.draftQuality.score : null,
				message.value.draftQuality?.flags ?? []
			)
);

const {
	arm: armApproveUndo,
	state: approveUndoState,
	dismiss: dismissApproveUndo,
} = useReviewApproveUndo();

async function undoApproveInverse(messageId: Id<'inboundMessages'>) {
	if (approveUndoState.value.inboundMessageId === messageId) dismissApproveUndo();
	const result = await undoApprove(messageId);
	if (!result.ok) return;
	if (result.result.cancelled) showToast(t('shared.reviewBulkSummary.undoneOne'));
	else if (result.result.reason === 'already_sent')
		showToast(t('shared.reviewBulkSummary.tooLateOne'), 'warning');
}

/** Lost race: approved or declined elsewhere. Say so and move on, untallied. */
function handledAlreadyHandled(result: unknown): boolean {
	if (!isApproveAlreadyHandled(result)) return false;
	showToast(t('shared.reviewApprove.alreadyHandled'), 'info');
	props.controls.skip();
	return true;
}

async function approve() {
	if (busy.value || isHeld.value) return;
	busy.value = true;
	try {
		const m = message.value;
		const options = m.draftOptions;
		const result =
			options && options.length > 1
				? await approveOption(m._id, options[0]!, m.draftResponse)
				: await onApprove(m._id);
		if (!result.ok) return;
		if (isReplyCollision(result.result)) {
			showToast(
				collisionText(replyCollisionToast(result.result.heldByName ?? t(GENERIC_TEAMMATE_NAME))),
				'error'
			);
			return;
		}
		if (handledAlreadyHandled(result.result)) return;
		const undo = approveUndoWindow(result.result);
		if (undo) {
			armApproveUndo({
				inboundMessageId: m._id,
				sendAt: undo.sendAt,
				onUndo: () => props.controls.undoSelf(),
			});
		} else {
			showToast(t('components.agentTasks.reviewFocusFlow.toasts.draftApproved'));
		}
		props.controls.complete('approved', undo ? () => undoApproveInverse(m._id) : undefined);
	} finally {
		busy.value = false;
	}
}

async function reject() {
	if (busy.value) return;
	busy.value = true;
	try {
		const result = await onReject(message.value._id);
		if (result.ok) props.controls.complete('rejected');
	} finally {
		busy.value = false;
	}
}

async function sendReply() {
	const body = composeBody.value;
	if (busy.value || isHeld.value || body.trim().length === 0) return;
	busy.value = true;
	try {
		const result = await composeAndSend(message.value._id, body);
		if (!result.ok) return;
		if (isReplyCollision(result.result)) {
			showToast(
				collisionText(replyCollisionToast(result.result.heldByName ?? t(GENERIC_TEAMMATE_NAME))),
				'error'
			);
			return;
		}
		if (handledAlreadyHandled(result.result)) return;
		composeBody.value = '';
		showToast(t('components.agentTasks.reviewFocusFlow.toasts.replySent'));
		props.controls.complete('sent');
	} finally {
		busy.value = false;
	}
}

function openThread() {
	if (props.entry.thread) void navigateTo(`/dashboard/inbox/${props.entry.thread._id}`);
}

function onKeydown(event: KeyboardEvent) {
	if (event.metaKey || event.ctrlKey || event.altKey) return;
	if (isEditableTarget(event.target)) return;
	const action = resolveReviewFocusKey(event.key, {
		currentKind: draftless.value ? 'reply' : 'draft_review',
		needsReply: draftless.value,
	});
	if (!action) return;
	event.preventDefault();
	if (action === 'reject') void reject();
	else if (action === 'approve') void approve();
	else if (action === 'sendReply') void sendReply();
	else props.controls.skip();
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

const secondaryButton =
	'inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors duration-(--motion-fast)';
</script>

<template>
	<TaskCardShell>
		<TaskContext :who="message.from" icon="lucide:mail">
			<template #trailing>
				<div v-if="message.classification" class="flex items-center gap-2">
					<InboxTrustChip :trust="trust" />
					<span class="text-xs px-2 py-0.5 rounded-full bg-brand-subtle text-brand">
						{{ message.classification.category }}
					</span>
				</div>
			</template>
		</TaskContext>

		<TaskAsk
			class="mt-3 mb-4"
			:ask="message.subject || undefined"
			:detail="message.textBody || t('components.agentTasks.reviewFocusFlow.noTextContent')"
			:why="
				message.agentDecision?.reason
					? t(
							draftless
								? 'components.agentTasks.reviewFocusFlow.escalatedBecause'
								: 'components.agentTasks.reviewFocusFlow.heldBecause',
							{ reason: message.agentDecision.reason }
						)
					: undefined
			"
		/>

		<!-- Draftless escalation: compose a reply inline -->
		<template v-if="draftless">
			<textarea
				v-model="composeBody"
				rows="6"
				class="input w-full text-sm resize-y mb-4"
				:placeholder="t('components.agentTasks.reviewFocusFlow.replyPlaceholder')"
			/>
			<TaskActions
				:primary-label="t('components.agentTasks.reviewFocusFlow.sendReply')"
				primary-icon="lucide:send"
				:primary-disabled="busy || !composeBody.trim()"
				:primary-loading="busy"
				:held="isHeld"
				:held-reason="heldReason"
				:skip-label="t('common.dismiss')"
				skip-destructive
				:skip-disabled="busy"
				@primary="sendReply"
				@skip="reject"
			>
				<button v-if="entry.thread" type="button" :class="secondaryButton" @click="openThread">
					<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
					{{ t('components.agentTasks.reviewFocusFlow.openThread') }}
				</button>
			</TaskActions>
		</template>

		<!-- Agent draft awaiting approval -->
		<template v-else>
			<div class="bg-brand-subtle/30 rounded-lg p-4 mb-4">
				<div class="flex items-center gap-2 mb-2">
					<Icon name="lucide:bot" class="w-4 h-4 text-brand" />
					<p class="text-xs font-medium text-brand uppercase tracking-wider">
						{{ t('components.agentTasks.reviewFocusFlow.draftReady') }}
					</p>
					<span
						v-if="(message.draftOptions?.length ?? 0) > 1"
						class="text-[10px] text-text-tertiary"
					>
						· {{ t('components.agentTasks.reviewFocusFlow.pickAnotherOption') }}
					</span>
				</div>
				<p class="text-text-primary text-sm whitespace-pre-wrap">{{ message.draftResponse }}</p>
			</div>
			<InboxDecisionRationale :grounding-sources="message.groundingSources" class="mb-4" />
			<TaskActions
				:primary-label="t('components.agentTasks.reviewFocusFlow.reviewAndSend')"
				primary-icon="lucide:check"
				:primary-disabled="busy"
				:primary-loading="busy"
				:held="isHeld"
				:held-reason="heldReason"
				:skip-label="t('components.agentTasks.reviewFocusFlow.reject')"
				skip-destructive
				:skip-disabled="busy"
				:hints="[{ keys: ['a'], label: t('components.agentTasks.reviewFocusFlow.reviewAndSend') }]"
				@primary="approve"
				@skip="reject"
			>
				<button v-if="entry.thread" type="button" :class="secondaryButton" @click="openThread">
					<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
					{{ t('components.agentTasks.reviewFocusFlow.editInThread') }}
				</button>
			</TaskActions>
		</template>
	</TaskCardShell>
</template>
