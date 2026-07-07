<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import AgentTaskFlow from '~/components/agent-tasks/AgentTaskFlow.vue';
import TaskActions from '~/components/agent-tasks/TaskActions.vue';
import TaskAsk from '~/components/agent-tasks/TaskAsk.vue';
import TaskCardShell from '~/components/agent-tasks/TaskCardShell.vue';
import TaskContext from '~/components/agent-tasks/TaskContext.vue';
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

const { reviewItems, isLoading, needsReply, onApprove, approveOption, onReject, composeAndSend } =
	useReviewQueue();

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
const estimateLabel = computed(() => formatTaskFlowEstimate(flow.remainingSeconds.value));
const peekLabel = computed(() => {
	const n = flow.nextItem.value;
	return n ? n.message.subject || '(no subject)' : '';
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
	return m ? m.user.name || m.user.email : GENERIC_TEAMMATE_NAME;
});
const heldReason = computed(() =>
	isHeld.value && heldByName.value ? sendHoldReason(heldByName.value) : undefined
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
// card — a = approve (send), x = reject, Enter = the primary action. Inert
// while typing a reply into the compose box (isEditableTarget).
function onCardKeydown(event: KeyboardEvent) {
	if (!flow.active.value || flow.isComplete.value) return;
	if (event.metaKey || event.ctrlKey || event.altKey) return;
	if (isEditableTarget(event.target)) return;
	const row = current.value;
	if (!row) return;
	const k = event.key.toLowerCase();
	if (k === 'x') {
		event.preventDefault();
		void reject(row);
	} else if (k === 'a' && !needsReply(row.message)) {
		event.preventDefault();
		void approve(row);
	} else if (k === 'enter') {
		event.preventDefault();
		if (needsReply(row.message)) void sendReply(row);
		else void approve(row);
	}
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
			showToast(replyCollisionToast(result.heldByName ?? GENERIC_TEAMMATE_NAME), 'error');
			return;
		}
		showToast('Draft approved and queued for sending');
		flow.complete(row.id, { outcome: 'approved' });
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
			showToast(replyCollisionToast(result.heldByName ?? GENERIC_TEAMMATE_NAME), 'error');
			return;
		}
		delete composeBody[row.message._id];
		showToast('Reply sent');
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
		<p class="text-text-secondary font-medium">All caught up!</p>
		<p class="text-sm text-text-tertiary mt-1">No drafts need your review right now.</p>
		<button type="button" class="btn btn-secondary text-sm mt-6" @click="emit('exit')">
			Back to list
		</button>
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
			<TaskCardShell>
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
					:detail="current.message.textBody || '(No text content)'"
					:why="
						current.message.agentDecision?.reason
							? (needsReply(current.message) ? 'Escalated because: ' : 'Held because: ') +
								current.message.agentDecision.reason
							: undefined
					"
				/>

				<!-- Draftless escalation: compose a reply inline -->
				<template v-if="needsReply(current.message)">
					<textarea
						v-model="composeBody[current.message._id]"
						rows="6"
						class="input w-full text-sm resize-y mb-4"
						placeholder="Type your reply…"
					/>
					<TaskActions
						primary-label="Send Reply"
						primary-icon="lucide:send"
						:primary-disabled="busy || !composeBody[current.message._id]?.trim()"
						:primary-loading="busy"
						:held="isHeld"
						:held-reason="heldReason"
						skip-label="Dismiss"
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
							Open thread
						</button>
					</TaskActions>
				</template>

				<!-- Agent draft awaiting approval -->
				<template v-else>
					<div class="bg-brand-subtle/30 rounded-lg p-4 mb-4">
						<div class="flex items-center gap-2 mb-2">
							<Icon name="lucide:bot" class="w-4 h-4 text-brand" />
							<p class="text-xs font-medium text-brand uppercase tracking-wider">Draft ready</p>
							<span
								v-if="(current.message.draftOptions?.length ?? 0) > 1"
								class="text-[10px] text-text-tertiary"
							>
								· Edit in thread to pick another option
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
						primary-label="Approve & Send"
						primary-icon="lucide:check"
						:primary-disabled="busy"
						:primary-loading="busy"
						:held="isHeld"
						:held-reason="heldReason"
						skip-label="Reject"
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
							Edit in thread
						</button>
					</TaskActions>
				</template>
			</TaskCardShell>
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
				<h2 class="font-display text-xl text-text-primary">All caught up</h2>
				<p v-if="flow.summary.value" class="mt-1.5 text-sm text-text-secondary">
					{{ flow.summary.value }} this session.
				</p>
				<p class="mt-1 text-xs text-text-tertiary">
					New drafts and escalations will appear here as the agent routes them.
				</p>
				<div class="mt-6 flex items-center justify-center gap-2">
					<button type="button" class="btn btn-secondary text-sm" @click="emit('exit')">
						Back to list
					</button>
					<NuxtLink to="/dashboard/inbox" class="btn btn-secondary text-sm">
						Back to inbox
					</NuxtLink>
				</div>
			</div>
		</template>
	</AgentTaskFlow>
</template>
