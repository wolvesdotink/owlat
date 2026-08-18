<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import AgentTaskFlow from '~/components/agent-tasks/AgentTaskFlow.vue';
import TaskActions from '~/components/agent-tasks/TaskActions.vue';
import TaskAsk from '~/components/agent-tasks/TaskAsk.vue';
import TaskCardRenderer from '~/components/agent-tasks/TaskCardRenderer.vue';
import TaskCardShell from '~/components/agent-tasks/TaskCardShell.vue';
import TaskContext from '~/components/agent-tasks/TaskContext.vue';
import { isBuiltInTaskFlowKind } from '~/utils/taskCardRegistry';
import { resolveReviewFocusKey } from '~/utils/taskFlowKeyboard';
import { useOrganization } from '~/composables/useOrganization';
import { useTaskFlow } from '~/composables/useTaskFlow';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import {
	GENERIC_TEAMMATE_NAME,
	isReplyCollision,
	replyCollisionToast,
	sendHoldReason,
} from '~/utils/replyCollision';
import { formatTaskFlowEstimate, type TaskFlowKind, type TaskFlowOrderKey } from '~/utils/taskFlow';
import { escalationTrustLabel, trustLabel, type TrustLabel } from '~/utils/trustLabel';

/**
 * The team Review Queue's "Focus" flow — the SAME focused card-stack as the
 * personal Reply Queue, over the shared-inbox review items. A separate flow
 * (different data source: the agent's draft_ready queue), so the two never
 * interleave. The review.vue list view stays as the browse alternative; this
 * is the one-task-at-a-time entry point.
 */
const emit = defineEmits<{ (e: 'exit'): void }>();

const { t } = useI18n();

/**
 * Collision copy lives in utils/replyCollision as an i18n key + params (the
 * registry convention for module-scope definitions); the string form is still
 * accepted so a plain sentence renders as itself.
 */
type CollisionMessage = string | { key: string; params?: Record<string, unknown> };
function collisionText(message: CollisionMessage): string {
	return typeof message === 'string' ? t(message) : t(message.key, message.params ?? {});
}

const {
	reviewItems,
	isLoading,
	needsReply,
	onApprove,
	approveOption,
	onReject,
	undoApprove,
	composeAndSend,
} = useReviewQueue();

type ReviewEntry = NonNullable<typeof reviewItems.value>[number];
type FlowItem = ReviewEntry & { id: string };
const source = computed<FlowItem[]>(() =>
	(reviewItems.value ?? []).map((it) => ({ ...it, id: it.message._id }))
);

function orderKey(item: FlowItem): TaskFlowOrderKey {
	const kind: TaskFlowKind = needsReply(item.message) ? 'reply' : 'draft_review';
	return { id: item.id, kind, threadId: item.thread?._id, contactKey: item.message.from };
}

const flow = useTaskFlow<FlowItem>(source, { key: orderKey });

const current = computed(() => flow.current.value);
/** The current card's kind — drives native rendering vs the fallback dispatcher. */
const currentKind = computed<TaskFlowKind | null>(() =>
	current.value ? orderKey(current.value).kind : null
);
const { isEnabled: isFeatureEnabled } = useFeatureFlag();
const estimateLabel = computed(() => formatTaskFlowEstimate(flow.remainingSeconds.value));
const peekLabel = computed(() => {
	const n = flow.nextItem.value;
	return n ? n.message.subject || t('components.agentTasks.reviewFocusFlow.noSubject') : '';
});

// Collision soft-hold: while ANOTHER teammate is actively replying to the
// current card's thread, hold the send/approve button (disabled-styled but
// visible) so we don't double-answer. Read-only presence subscription (this
// fast card stack doesn't advertise its own heartbeat); the server re-checks at
// send time as a belt-and-braces guard. Releases on its own when they drop.
const { user } = useAuth();
const { members, fetchMembers } = useOrganization();
onMounted(() => void fetchMembers());

const currentThreadId = computed<Id<'conversationThreads'> | null>(
	() => current.value?.thread?._id ?? null
);
const { data: presenceData } = useConvexQuery(api.inbox.presence.list, () =>
	currentThreadId.value ? { threadId: currentThreadId.value } : 'skip'
);
const heldReplier = computed(() => {
	const uid = user.value?.id;
	return (presenceData.value ?? []).find((r) => r.mode === 'replying' && r.userId !== uid) ?? null;
});
const isHeld = computed(() => heldReplier.value !== null);
const heldByName = computed(() => {
	if (!heldReplier.value) return null;
	const m = members.value.find((x) => x.userId === heldReplier.value!.userId);
	return m ? m.user.name || m.user.email : t(GENERIC_TEAMMATE_NAME);
});
const heldReason = computed(() =>
	isHeld.value && heldByName.value ? collisionText(sendHoldReason(heldByName.value)) : undefined
);

const started = ref(false);
watch(
	[isLoading, source],
	() => {
		if (started.value || flow.active.value) return;
		if (!isLoading.value && source.value.length > 0) {
			flow.start();
			started.value = true;
		}
	},
	{ immediate: true }
);

// Keyboard: Cmd/Ctrl+Z undo (flow) plus the Review vocabulary on the focused
// card — a = approve (send), x = reject, Enter = the primary action. Gated to
// built-in kinds: a plugin/unknown card only honours `s` → skip (its native
// controls own everything else), so the ambient shortcuts can never fire a
// hidden send/reject/archive on a card that does not display them. Inert while
// typing a reply into the compose box (isEditableTarget).
function onCardKeydown(event: KeyboardEvent) {
	if (!flow.active.value || flow.isComplete.value) return;
	if (event.metaKey || event.ctrlKey || event.altKey) return;
	if (isEditableTarget(event.target)) return;
	const row = current.value;
	if (!row) return;
	const action = resolveReviewFocusKey(event.key, {
		currentKind: currentKind.value,
		needsReply: needsReply(row.message),
	});
	if (!action) return;
	event.preventDefault();
	if (action === 'reject') void reject(row);
	else if (action === 'approve') void approve(row);
	else if (action === 'sendReply') void sendReply(row);
	else flow.skip(row.id);
}
onMounted(() => {
	window.addEventListener('keydown', flow.onWindowKeydown);
	window.addEventListener('keydown', onCardKeydown);
});
onBeforeUnmount(() => {
	window.removeEventListener('keydown', flow.onWindowKeydown);
	window.removeEventListener('keydown', onCardKeydown);
});

const { showToast } = useToast();
const busy = ref(false);

function rowTrust(message: FlowItem['message']): TrustLabel {
	if (needsReply(message)) return escalationTrustLabel();
	return trustLabel(
		message.draftQuality ? message.draftQuality.score : null,
		message.draftQuality?.flags ?? []
	);
}

// Draftless-escalation compose box (keyed by message id).
const composeBody = reactive<Record<string, string>>({});

// Countdown-undo toast + true inverse for approvals inside their server-side
// undo window (agentConfig.humanApproveUndoDelayMs, piece C1). The flow's
// Cmd/Ctrl+Z (and the chrome Undo button) run the inverse, which actually
// un-sends: undoAutoSend cancels the held send and routes the draft back to
// `draft_ready` — the flow then re-shows the card from its cache.
const {
	state: approveUndoState,
	arm: armApproveUndo,
	dismiss: dismissApproveUndo,
} = useReviewApproveUndo();

async function undoApproveInverse(messageId: Id<'inboundMessages'>) {
	// The flow undo owns this reversal now — drop a stale toast for the same card.
	if (approveUndoState.value.inboundMessageId === messageId) dismissApproveUndo();
	const result = await undoApprove(messageId);
	if (result === undefined) return; // categorized failure — already toasted
	if (result.cancelled) {
		showToast(t('shared.reviewBulkSummary.undoneOne'));
	} else if (result.reason === 'already_sent') {
		showToast(t('shared.reviewBulkSummary.tooLateOne'), 'warning');
	}
	// 'no_pending_send': the toast's Undo already cancelled it (this inverse ran
	// as part of flow.undo) or the send fully completed — nothing left to say.
}

/**
 * The lost race: the draft was already approved or declined (double-click, or a
 * teammate got there first), so the server refused the edge and scheduled
 * NOTHING. Say so honestly and move the card out of the way with `skip` — it is
 * gone from the queue, but it was not OUR approval, so it must not land in the
 * end-state tally and there is no held send to register an inverse for.
 */
function handledAlreadyHandled(result: unknown, row: FlowItem): boolean {
	if (!isApproveAlreadyHandled(result)) return false;
	showToast(t('shared.reviewApprove.alreadyHandled'), 'info');
	flow.skip(row.id);
	return true;
}

async function approve(row: FlowItem) {
	if (busy.value || isHeld.value) return;
	busy.value = true;
	try {
		const options = row.message.draftOptions;
		const result =
			options && options.length > 1
				? await approveOption(row.message._id, options[0]!, row.message.draftResponse)
				: await onApprove(row.message._id);
		if (result === undefined) return;
		// Server refused because a teammate just replied — toast, don't advance.
		if (isReplyCollision(result)) {
			showToast(
				collisionText(replyCollisionToast(result.heldByName ?? t(GENERIC_TEAMMATE_NAME))),
				'error'
			);
			return;
		}
		if (handledAlreadyHandled(result, row)) return;
		const undo = approveUndoWindow(result);
		if (undo) {
			// The toast's Undo targets THIS card's completion (flow.undoById, which
			// runs the registered inverse below and rewinds position/tally with it)
			// — never a blanket flow.undo(), which pops the LAST action: rejecting
			// another card while the toast is up would rewind THAT card while this
			// one's held send still fires. Mirrors the browse list's per-message
			// `undoApproveAndRestore(messageId)` binding.
			armApproveUndo({
				inboundMessageId: row.message._id,
				sendAt: undo.sendAt,
				onUndo: () => void flow.undoById(row.message._id),
			});
		} else {
			showToast(t('components.agentTasks.reviewFocusFlow.toasts.draftApproved'));
		}
		flow.complete(row.id, {
			outcome: 'approved',
			...(undo ? { inverse: () => undoApproveInverse(row.message._id) } : {}),
		});
	} finally {
		busy.value = false;
	}
}

async function reject(row: FlowItem) {
	if (busy.value) return;
	busy.value = true;
	try {
		const result = await onReject(row.message._id);
		if (result === undefined) return;
		flow.complete(row.id, { outcome: 'rejected' });
	} finally {
		busy.value = false;
	}
}

async function sendReply(row: FlowItem) {
	const body = composeBody[row.message._id] ?? '';
	if (busy.value || isHeld.value || body.trim().length === 0) return;
	busy.value = true;
	try {
		const result = await composeAndSend(row.message._id, body);
		if (result === undefined) return;
		// Server refused because a teammate just replied — toast, don't advance.
		if (isReplyCollision(result)) {
			showToast(
				collisionText(replyCollisionToast(result.heldByName ?? t(GENERIC_TEAMMATE_NAME))),
				'error'
			);
			return;
		}
		if (handledAlreadyHandled(result, row)) return;
		delete composeBody[row.message._id];
		showToast(t('components.agentTasks.reviewFocusFlow.toasts.replySent'));
		flow.complete(row.id, { outcome: 'sent' });
	} finally {
		busy.value = false;
	}
}

function openThread(row: FlowItem) {
	if (row.thread) void navigateTo(`/dashboard/inbox/${row.thread._id}`);
}
</script>

<template>
	<div v-if="isLoading && !flow.active.value" class="p-10 text-center">
		<UiSpinner class="mx-auto" />
	</div>

	<div
		v-else-if="!flow.active.value && source.length === 0"
		class="flex flex-col items-center justify-center py-16 text-center"
	>
		<UiIconBox icon="lucide:check-circle" size="xl" variant="success" rounded="full" class="mb-4" />
		<p class="text-text-secondary font-medium">
			{{ t('components.agentTasks.reviewFocusFlow.empty.title') }}
		</p>
		<p class="text-sm text-text-tertiary mt-1">
			{{ t('components.agentTasks.reviewFocusFlow.empty.body') }}
		</p>
		<UiButton variant="secondary" type="button" class="text-sm mt-6" @click="emit('exit')">
			{{ t('components.agentTasks.reviewFocusFlow.backToList') }}
		</UiButton>
	</div>

	<AgentTaskFlow
		v-else
		:position="flow.position.value"
		:total="flow.total.value"
		:new-count="flow.newCount.value"
		:estimate-label="estimateLabel"
		:current-key="flow.currentId.value"
		:peek-label="peekLabel"
		:complete="flow.isComplete.value"
		:can-undo="flow.canUndo.value"
		@exit="emit('exit')"
		@undo="flow.undo()"
	>
		<template v-if="current">
			<TaskCardShell v-if="currentKind && isBuiltInTaskFlowKind(currentKind)">
				<TaskContext :who="current.message.from" icon="lucide:mail">
					<template #trailing>
						<div v-if="current.message.classification" class="flex items-center gap-2">
							<InboxTrustChip :trust="rowTrust(current.message)" />
							<span class="text-xs px-2 py-0.5 rounded-full bg-brand-subtle text-brand">
								{{ current.message.classification.category }}
							</span>
						</div>
					</template>
				</TaskContext>

				<TaskAsk
					class="mt-3 mb-4"
					:ask="current.message.subject || undefined"
					:detail="
						current.message.textBody || t('components.agentTasks.reviewFocusFlow.noTextContent')
					"
					:why="
						current.message.agentDecision?.reason
							? t(
									needsReply(current.message)
										? 'components.agentTasks.reviewFocusFlow.escalatedBecause'
										: 'components.agentTasks.reviewFocusFlow.heldBecause',
									{ reason: current.message.agentDecision.reason }
								)
							: undefined
					"
				/>

				<!-- Draftless escalation: compose a reply inline -->
				<template v-if="needsReply(current.message)">
					<textarea
						v-model="composeBody[current.message._id]"
						rows="6"
						class="input w-full text-sm resize-y mb-4"
						:placeholder="t('components.agentTasks.reviewFocusFlow.replyPlaceholder')"
					/>
					<TaskActions
						:primary-label="t('components.agentTasks.reviewFocusFlow.sendReply')"
						primary-icon="lucide:send"
						:primary-disabled="busy || !composeBody[current.message._id]?.trim()"
						:primary-loading="busy"
						:held="isHeld"
						:held-reason="heldReason"
						:skip-label="t('common.dismiss')"
						skip-destructive
						:skip-disabled="busy"
						@primary="sendReply(current!)"
						@skip="reject(current!)"
					>
						<button
							v-if="current.thread"
							type="button"
							class="inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors duration-(--motion-fast)"
							@click="openThread(current!)"
						>
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
								v-if="(current.message.draftOptions?.length ?? 0) > 1"
								class="text-[10px] text-text-tertiary"
							>
								· {{ t('components.agentTasks.reviewFocusFlow.pickAnotherOption') }}
							</span>
						</div>
						<p class="text-text-primary text-sm whitespace-pre-wrap">
							{{ current.message.draftResponse }}
						</p>
					</div>
					<InboxDecisionRationale
						:grounding-sources="current.message.groundingSources"
						class="mb-4"
					/>
					<TaskActions
						:primary-label="t('components.agentTasks.reviewFocusFlow.approveAndSend')"
						primary-icon="lucide:check"
						:primary-disabled="busy"
						:primary-loading="busy"
						:held="isHeld"
						:held-reason="heldReason"
						:skip-label="t('components.agentTasks.reviewFocusFlow.reject')"
						skip-destructive
						:skip-disabled="busy"
						@primary="approve(current!)"
						@skip="reject(current!)"
					>
						<button
							v-if="current.thread"
							type="button"
							class="inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors duration-(--motion-fast)"
							@click="openThread(current!)"
						>
							<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
							{{ t('components.agentTasks.reviewFocusFlow.editInThread') }}
						</button>
					</TaskActions>
				</template>
			</TaskCardShell>

			<!-- Unknown/disabled or plugin-contributed kind: never crash, never
			     drop it — render (or gracefully fall back to) its card, and keep
			     it skippable so the queue can advance. -->
			<TaskCardRenderer
				v-else-if="currentKind"
				:kind="currentKind"
				:item="current"
				:is-flag-enabled="isFeatureEnabled"
				:can-open="!!current.thread"
				@skip="flow.skip(current!.id)"
				@open="openThread(current!)"
				@complete="(outcome) => flow.complete(current!.id, { outcome: outcome ?? 'completed' })"
			/>
		</template>

		<template #done>
			<div class="text-center py-8">
				<UiIconBox
					icon="lucide:check-circle-2"
					size="xl"
					variant="success"
					rounded="full"
					class="mb-4"
				/>
				<h2 class="font-display text-xl text-text-primary">
					{{ t('components.agentTasks.reviewFocusFlow.done.title') }}
				</h2>
				<p v-if="flow.summary.value" class="mt-1.5 text-sm text-text-secondary">
					{{
						t('components.agentTasks.reviewFocusFlow.done.summary', {
							summary: flow.summary.value,
						})
					}}
				</p>
				<p class="mt-1 text-xs text-text-tertiary">
					{{ t('components.agentTasks.reviewFocusFlow.done.body') }}
				</p>
				<div class="mt-6 flex items-center justify-center gap-2">
					<UiButton variant="secondary" type="button" class="text-sm" @click="emit('exit')">
						{{ t('components.agentTasks.reviewFocusFlow.backToList') }}
					</UiButton>
					<UiButton variant="secondary" to="/dashboard/inbox" class="text-sm">
						{{ t('components.agentTasks.reviewFocusFlow.backToInbox') }}
					</UiButton>
				</div>
			</div>
		</template>
	</AgentTaskFlow>
</template>
