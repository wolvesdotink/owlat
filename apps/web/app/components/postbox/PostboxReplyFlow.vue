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
import { resolveReplyFocusKey } from '~/utils/taskFlowKeyboard';
import type { ReplyQuoteTarget } from '~/composables/postbox/usePostboxQuotedText';
import { useTaskFlow } from '~/composables/useTaskFlow';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import { formatTaskFlowEstimate, type TaskFlowKind, type TaskFlowOrderKey } from '~/utils/taskFlow';
import {
	replyQueueHeadline,
	formatReplyQueueDueHint,
	replyQueueSection,
	type ReplyQueueItem,
} from '~/utils/postboxReplyQueue';

/**
 * The focused Reply Queue flow — the PERSONAL agent queue rendered as the
 * card-stack (one AgentTaskCard at a time, auto-advancing). Same components as
 * the team Review Queue's Focus flow; different data source (the mailbox's
 * needs-reply subscription). All the queue's actions survive — Answer a
 * clarification, Review & send a draft, Draft reply, Done, Snooze, Archive,
 * Open — but shown one task at a time instead of as a two-section listbox.
 */
const props = defineProps<{ mailboxId: Id<'mailboxes'> }>();

const mailboxIdRef = computed(() => props.mailboxId as Id<'mailboxes'> | null);
const { items, isLoading } = usePostboxReplyQueue(mailboxIdRef);

// Snapshot key: the item id is its threadId (one queue row per thread).
type FlowItem = ReplyQueueItem & { id: string };
const source = computed<FlowItem[]>(() => items.value.map((i) => ({ ...i, id: i.threadId })));

/** Map a queue row onto the flow's ordering key. */
function orderKey(item: FlowItem): TaskFlowOrderKey {
	let kind: TaskFlowKind = 'reply';
	if (replyQueueSection(item) === 'needs_input') kind = 'question';
	else if (item.kind !== 'followup' && item.draftSlot) kind = 'draft_review';
	return { id: item.id, kind, threadId: item.threadId, contactKey: item.fromAddress };
}

const flow = useTaskFlow<FlowItem>(source, { key: orderKey });

const current = computed(() => flow.current.value);
/** The current card's kind — drives native rendering vs the fallback dispatcher. */
const currentKind = computed<TaskFlowKind | null>(() =>
	current.value ? orderKey(current.value).kind : null
);
const estimateLabel = computed(() => formatTaskFlowEstimate(flow.remainingSeconds.value));
const peekLabel = computed(() =>
	flow.nextItem.value ? replyQueueHeadline(flow.nextItem.value) : ''
);

// Enter the flow once the live queue has loaded with at least one item.
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

// Keyboard: Cmd/Ctrl+Z undo (flow), plus the Postbox row conventions on the
// focused card — Enter = reply/done, e = archive. Gated to built-in kinds: a
// plugin/unknown card only honours `s` → skip (its native controls own
// everything else), so the ambient shortcuts can never fire a hidden reply or
// archive on a card that does not display them. Inert while typing.
function onCardKeydown(event: KeyboardEvent) {
	if (!flow.active.value || flow.isComplete.value) return;
	if (event.metaKey || event.ctrlKey || event.altKey) return;
	if (isEditableTarget(event.target)) return;
	const row = current.value;
	if (!row) return;
	const action = resolveReplyFocusKey(event.key, {
		currentKind: currentKind.value,
		isFollowup: row.kind === 'followup',
	});
	if (!action) return;
	event.preventDefault();
	if (action === 'markDone') void markDone(row);
	else if (action === 'draftReply') void draftReply(row);
	else if (action === 'archive') void archiveRow(row);
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

// ---- Actions (same Convex surface the listbox Reply Queue uses) -------------
const { isEnabled: isFeatureEnabled } = useFeatureFlag();
const aiEnabled = computed(() => isFeatureEnabled('ai'));
const stack = usePostboxComposerStack();

const clearOp = useBackendOperation(api.mail.needsReply.clear, { label: 'Mark done' });
const cancelFollowUpOp = useBackendOperation(api.mail.followUps.cancel, {
	label: 'Dismiss reminder',
});
const archiveOp = useBackendOperation(api.mail.messageActions.archive, { label: 'Archive' });
const moveOp = useBackendOperation(api.mail.messageActions.move, { label: 'Move' });
const snoozeOp = useBackendOperation(api.mail.snooze.snooze, { label: 'Snooze' });
const suggestOp = useBackendOperation(api.mail.ai.suggestReplies, {
	label: 'Draft reply',
	type: 'action',
});
const answerOp = useBackendOperation(api.mail.needsReplyClarify.answerClarification, {
	label: 'Answer',
});

const busy = ref(false);

/** Answer a clarification card; the server generates the starter reply. */
async function submitClarification(
	row: FlowItem,
	answers: { questionId: string; value: string }[]
) {
	if (busy.value) return;
	busy.value = true;
	try {
		await answerOp.run({ threadId: row.threadId as Id<'mailThreads'>, answers });
		flow.complete(row.id, { outcome: 'answered' });
	} finally {
		busy.value = false;
	}
}

/** Open the composer prefilled with a draft (clarification/review/plain). */
async function openReplyComposer(row: FlowItem, bodyText: string) {
	const messageId = row.messageId as Id<'mailMessages'>;
	let target: ReplyQuoteTarget = { ...row, _id: row.messageId };
	try {
		const message = await requireConvex().query(api.mail.mailbox.getMessage, { messageId });
		if (message) target = message;
		target = await resolveBodyFields(target);
	} catch {
		// Fall through with the queue row's fields — the composer still opens.
	}
	stack.open(buildReplySpec(props.mailboxId, target, bodyText));
}

/** "Open draft" on a ready clarification card — advances (task handed off). */
async function openClarificationDraft(row: FlowItem, draft: string) {
	await openReplyComposer(row, draft);
	flow.complete(row.id, { outcome: 'answered' });
}

/** "Review & send" on a draft-on-arrival slot — opens composer, advances. */
async function reviewSlot(row: FlowItem, draft: string) {
	await openReplyComposer(row, draft);
	flow.complete(row.id, { outcome: 'replied' });
}

/** "Draft reply": ask for a starter and open the composer, then advance. */
async function draftReply(row: FlowItem) {
	if (busy.value) return;
	busy.value = true;
	try {
		let suggestion = '';
		if (aiEnabled.value) {
			const res = await suggestOp.run({ messageId: row.messageId as Id<'mailMessages'> });
			suggestion = res?.replies[0] ?? '';
		}
		await openReplyComposer(row, suggestion);
		flow.complete(row.id, { outcome: 'replied' });
	} finally {
		busy.value = false;
	}
}

/** Done — clear the flag (follow-ups cancel their reminder instead). */
async function markDone(row: FlowItem) {
	const result =
		row.kind === 'followup'
			? await cancelFollowUpOp.run({ threadId: row.threadId as Id<'mailThreads'> })
			: await clearOp.run({ threadId: row.threadId as Id<'mailThreads'> });
	if (result !== undefined) flow.complete(row.id, { outcome: 'cleared' });
}

/** Archive — moves the flagged message; Cmd/Ctrl+Z moves it back. */
async function archiveRow(row: FlowItem) {
	const result = await archiveOp.run({ messageIds: [row.messageId as Id<'mailMessages'>] });
	if (result == null || !('moved' in result)) return;
	const moved = result.moved;
	flow.complete(row.id, {
		outcome: 'archived',
		inverse: async () => {
			for (const m of moved) {
				await moveOp.run({ messageIds: [m.messageId], targetFolderId: m.sourceFolderId });
			}
		},
	});
}

// Snooze dialog — target captured so a focus change can't retarget the action.
const snoozeOpen = ref(false);
const snoozeTarget = ref<FlowItem | null>(null);
function openSnooze(row: FlowItem) {
	snoozeTarget.value = row;
	snoozeOpen.value = true;
}
async function confirmSnooze(until: number) {
	const row = snoozeTarget.value;
	snoozeTarget.value = null;
	if (!row) return;
	const result = await snoozeOp.run({ messageId: row.messageId as Id<'mailMessages'>, until });
	if (result !== undefined) flow.complete(row.id, { outcome: 'snoozed' });
}

function openRow(row: FlowItem) {
	void navigateTo(`/dashboard/postbox/inbox/${row.messageId}`);
}

const URGENCY_LABEL: Record<string, string> = { high: 'Urgent', low: 'Low priority' };
</script>

<template>
	<div v-if="isLoading && !flow.active.value" class="p-10 text-center">
		<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary mx-auto" />
	</div>

	<!-- Quiet inbox-zero moment before entering (or an empty queue). -->
	<PostboxEmptyState
		v-else-if="!flow.active.value && source.length === 0"
		icon="lucide:check-circle-2"
		title="All caught up"
		hint="Nothing is waiting on your reply."
	/>

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
		@exit="navigateTo('/dashboard/postbox/inbox')"
		@undo="flow.undo()"
	>
		<!-- The current card -->
		<template v-if="current">
			<!-- Needs-your-input clarification -->
			<PostboxClarificationCard
				v-if="
					currentKind &&
					isBuiltInTaskFlowKind(currentKind) &&
					replyQueueSection(current) === 'needs_input'
				"
				:item="current"
				:submitting="busy"
				@answer="(answers) => submitClarification(current!, answers)"
				@open-draft="(draft) => openClarificationDraft(current!, draft)"
				@open="openRow(current!)"
				@done="markDone(current!)"
				@defer="flow.skip(current!.id)"
			/>

			<!-- Plain needs-you / follow-up / draft-review card -->
			<TaskCardShell v-else-if="currentKind && isBuiltInTaskFlowKind(currentKind)">
				<TaskContext
					:who="current.fromName || current.fromAddress"
					:name="current.fromName"
					:email="current.fromAddress"
					:due="formatReplyQueueDueHint(current.dueHint) ?? undefined"
					:meta="formatCompactRelativeTime(current.receivedAt)"
				>
					<template #chips>
						<span
							v-if="current.kind === 'followup'"
							class="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide px-1.5 py-px rounded-full bg-brand/10 text-brand"
						>
							<Icon name="lucide:alarm-clock" class="w-3 h-3" />
							Follow-up
						</span>
						<span
							v-else-if="current.urgency !== 'normal'"
							class="text-[10px] font-medium uppercase tracking-wide px-1.5 py-px rounded-full"
							:class="
								current.urgency === 'high'
									? 'bg-error/10 text-error'
									: 'bg-bg-elevated text-text-tertiary'
							"
							>{{ URGENCY_LABEL[current.urgency] }}</span
						>
					</template>
				</TaskContext>

				<TaskAsk class="mt-3 mb-4" :ask="replyQueueHeadline(current)" :detail="current.snippet" />

				<!-- Draft-on-arrival review slot (human review only). -->
				<PostboxReviewSlot
					v-if="current.kind !== 'followup' && current.draftSlot"
					class="mb-4"
					:draft-slot="current.draftSlot"
					@review="(draft) => reviewSlot(current!, draft)"
					@dismiss="markDone(current!)"
				/>

				<TaskActions
					v-if="current.kind !== 'followup'"
					:primary-label="aiEnabled ? 'Draft reply' : 'Reply'"
					primary-icon="lucide:reply"
					:primary-disabled="busy"
					:primary-loading="busy"
					skip-label="Done"
					:hints="[
						{ keys: ['Enter'], label: 'Reply' },
						{ keys: ['e'], label: 'Archive' },
					]"
					@primary="draftReply(current!)"
					@skip="markDone(current!)"
				>
					<button
						type="button"
						class="inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors duration-(--motion-fast)"
						@click="openSnooze(current!)"
					>
						<Icon name="lucide:clock" class="w-3.5 h-3.5" />
						Snooze
					</button>
					<button
						type="button"
						class="inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors duration-(--motion-fast)"
						@click="archiveRow(current!)"
					>
						<Icon name="lucide:archive" class="w-3.5 h-3.5" />
						Archive
					</button>
					<button
						type="button"
						class="inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors duration-(--motion-fast)"
						@click="openRow(current!)"
					>
						<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
						Open
					</button>
				</TaskActions>

				<!-- Follow-up: we're waiting on THEM — Done dismisses the reminder. -->
				<TaskActions
					v-else
					primary-label="Done"
					primary-icon="lucide:check"
					:primary-disabled="busy"
					@primary="markDone(current!)"
				>
					<button
						type="button"
						class="inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors duration-(--motion-fast)"
						@click="openRow(current!)"
					>
						<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
						Open
					</button>
				</TaskActions>
			</TaskCardShell>

			<!-- Unknown/disabled or plugin-contributed kind: never crash, never
			     drop it — render (or gracefully fall back to) its card, and keep
			     it skippable so the queue can advance. -->
			<TaskCardRenderer
				v-else-if="currentKind"
				:kind="currentKind"
				:item="current"
				:is-flag-enabled="isFeatureEnabled"
				:can-open="true"
				@skip="flow.skip(current!.id)"
				@open="openRow(current!)"
			/>
		</template>

		<!-- End state -->
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
				<p class="mt-1 text-xs text-text-tertiary">New replies will appear here as they arrive.</p>
				<div class="mt-6 flex items-center justify-center gap-2">
					<NuxtLink to="/dashboard/postbox" class="btn btn-secondary text-sm">
						Back to Today
					</NuxtLink>
					<NuxtLink to="/dashboard/postbox/inbox" class="btn btn-secondary text-sm">
						Back to inbox
					</NuxtLink>
				</div>
			</div>
		</template>
	</AgentTaskFlow>

	<PostboxSnoozeDialog
		:open="snoozeOpen"
		@update:open="snoozeOpen = $event"
		@confirm="confirmSnooze"
	/>
	<PostboxComposerStack />
</template>
