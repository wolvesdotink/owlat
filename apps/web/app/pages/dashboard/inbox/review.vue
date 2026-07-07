<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import ReviewFocusFlow from '~/components/agent-tasks/ReviewFocusFlow.vue';
import TaskActions from '~/components/agent-tasks/TaskActions.vue';
import TaskAsk from '~/components/agent-tasks/TaskAsk.vue';
import TaskCardShell from '~/components/agent-tasks/TaskCardShell.vue';
import TaskContext from '~/components/agent-tasks/TaskContext.vue';
import { REVIEW_SHORTCUT_GROUPS } from '~/utils/reviewShortcuts';
import { escalationTrustLabel, trustLabel, type TrustLabel } from '~/utils/trustLabel';

useHead({ title: 'Review Queue — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'inbox',
});

const {
	reviewItems,
	isLoading,
	needsReply,
	onApprove,
	approveOption,
	onReject,
	composeAndSend,
	editDraft,
} = useReviewQueue();

// Persist a freeform whole-draft revision from the AiReviseBox onto the card's
// draft (through the same `editDraft` mutation an inline edit uses), so the
// revised text is what Approve & Send then queues. Fail-soft: editDraft toasts
// its own failures and resolves undefined, leaving the existing draft in place.
async function onReviseApply(messageId: Id<'inboundMessages'>, text: string) {
	const next = text.trim();
	if (next.length === 0) return;
	await editDraft({ inboundMessageId: messageId, draftResponse: next });
}

// One-tap "attach <file>?" from the review-gate suggestion. The autonomous send
// path never attaches (recipient-lock forbids a new attachment on an unattended
// reply), so attaching is human-confirmed: we surface the matched file and take
// the reviewer to the thread reply surface to finish and send. Naming the file
// in the toast keeps the confirmation explicit.
function onAttachSuggested(
	threadId: string | undefined,
	candidate: { fileId: string; filename: string }
) {
	showToast(`Suggested attachment: ${candidate.filename} — open the reply to attach and send`);
	if (threadId) {
		navigateTo(`/dashboard/inbox/${threadId}`);
	}
}

// "Focus" runs the same one-task-at-a-time card-stack flow (useTaskFlow) over
// these review items; the list below stays as the browse alternative. Separate
// flow from the personal Reply Queue — different data source, never interleaved.
const focusMode = ref(false);

// Action state
const actionInProgress = ref<string | null>(null);

// Per-card selected draft option (index into message.draftOptions) for the
// low-confidence cases where the agent offered 2–3 pickable variants. Defaults
// to 0 (the primary self-checked draft). Absent for single-draft cards.
const selectedOption = reactive<Record<string, number>>({});

// Per-card compose state for draftless complaint/urgent escalations: the agent
// pipeline skips the drafter for these, so there is no draft to approve — the
// admin types a reply here, which is persisted + sent through edit→approve.
const composeBody = reactive<Record<string, string>>({});
const composeSubject = reactive<Record<string, string>>({});

// Success toast
const { showToast } = useToast();

// "Coach my draft" is gated on the `ai` flag only (advisory, no per-user toggle).
const { isEnabled: isFeatureEnabled } = useFeatureFlag();
const aiEnabled = computed(() => isFeatureEnabled('ai'));

// Flat rows carrying an `_id` so the shared list-keyboard + optimistic-hide
// composables (which key on `_id`) can drive this page. Each row keeps its
// message + thread for rendering and navigation.
type ReviewRow = {
	_id: string;
	message: NonNullable<typeof reviewItems.value>[number]['message'];
	thread: NonNullable<typeof reviewItems.value>[number]['thread'];
};
const rows = computed<ReviewRow[]>(() =>
	(reviewItems.value ?? []).map((it) => ({
		_id: it.message._id,
		message: it.message,
		thread: it.thread,
	}))
);

// Human trust chip replacing the raw confidence % badge. Draft cards map the
// DRAFT self-check (score + flags → plain-language reasons); draftless
// escalations always read "Needs you". The old numbers stay reachable as the
// chip popover's quiet footer (rowTrustDetail) — disclosure, not deletion.
function rowTrust(message: ReviewRow['message']): TrustLabel {
	if (needsReply(message)) return escalationTrustLabel();
	return trustLabel(
		message.draftQuality ? message.draftQuality.score : null,
		message.draftQuality?.flags ?? []
	);
}

/** Quiet footer line keeping the classifier's certainty available to power users. */
function rowTrustDetail(message: ReviewRow['message']): string | undefined {
	const confidence = message.classification?.confidence;
	return typeof confidence === 'number'
		? `Classifier confidence ${Math.round(confidence * 100)}%`
		: undefined;
}

/**
 * The muted one-line WHY under the card's ask (shared task-card anatomy):
 * the route step's recorded reason for holding/escalating, moved up from the
 * old rationale block. Grounding provenance stays in InboxDecisionRationale.
 */
function rowWhy(message: ReviewRow['message']): string | undefined {
	const reason = message.agentDecision?.reason;
	if (!reason) return undefined;
	return needsReply(message) ? `Escalated because: ${reason}` : `Held because: ${reason}`;
}

// Optimistic row removal — approve/reject hide the row immediately and the live
// subscription confirms it; a failed action restores the row (usePostboxOptimisticHide).
const { visible: visibleRows, hide: hideRow, unhide: unhideRow } = usePostboxOptimisticHide(rows);

const onApproveClick = async (messageId: Id<'inboundMessages'>) => {
	actionInProgress.value = messageId;
	hideRow(messageId);
	try {
		const result = await onApprove(messageId);
		if (result === undefined) {
			unhideRow(messageId);
			return;
		}
		showToast('Draft approved and queued for sending');
	} finally {
		actionInProgress.value = null;
	}
};

// Approve the currently-selected draft option (multi-option cards). Falls back
// to the plain approve when no options were offered — same undo-guarded send.
const onApproveOptionClick = async (
	messageId: Id<'inboundMessages'>,
	options: readonly string[] | undefined,
	currentDraft: string | null | undefined
) => {
	if (!options || options.length < 2) {
		await onApproveClick(messageId);
		return;
	}
	const chosen = options[selectedOption[messageId] ?? 0] ?? options[0]!;
	actionInProgress.value = messageId;
	hideRow(messageId);
	try {
		const result = await approveOption(messageId, chosen, currentDraft);
		if (result === undefined) {
			unhideRow(messageId);
			return;
		}
		showToast('Draft approved and queued for sending');
	} finally {
		actionInProgress.value = null;
	}
};

const onRejectClick = async (messageId: Id<'inboundMessages'>) => {
	actionInProgress.value = messageId;
	hideRow(messageId);
	try {
		const result = await onReject(messageId);
		if (result === undefined) {
			unhideRow(messageId);
			return;
		}
		showToast('Draft rejected');
	} finally {
		actionInProgress.value = null;
	}
};

// Keyboard-first triage: j/k move, Enter opens the thread, a approves (through
// the SAME undo-guarded send the button calls), e edits, x/# rejects. Built by
// reusing the Postbox house composables; keys stay inert while the inline
// compose input/textarea is focused.
function openThread(row: ReviewRow) {
	if (row.thread) void navigateTo(`/dashboard/inbox/${row.thread._id}`);
}
const {
	focusedIndex,
	activeId: activeRowId,
	onKeydown: onQueueKeydown,
} = useReviewQueueKeyboard<ReviewRow>({
	items: visibleRows,
	resetKey: computed(() => (isLoading.value ? 'loading' : 'ready')),
	rowDomId: (row) => `review-row-${row._id}`,
	onOpen: openThread,
	// `a` only sends when there is an agent draft to approve; draftless
	// escalations (needsReply) have no draft, so fall back to opening the thread
	// where the admin composes the reply — never an empty auto-send.
	onApprove: (row) =>
		needsReply(row.message)
			? openThread(row)
			: void onApproveOptionClick(
					row.message._id,
					row.message.draftOptions,
					row.message.draftResponse
				),
	onEdit: openThread,
	onReject: (row) => void onRejectClick(row.message._id),
	// 1–9 — pick the matching draft option on multi-option cards.
	onPickOption: (row, index) => {
		const options = row.message.draftOptions;
		if (options && options.length > 1 && index < options.length) {
			selectedOption[row.message._id] = index;
		}
	},
});

// Focus the listbox on mount so j/k work without a click (keyboard-first).
const listboxEl = ref<HTMLElement | null>(null);
onMounted(() => {
	void nextTick(() => listboxEl.value?.focus());
});

const onComposeSend = async (messageId: Id<'inboundMessages'>) => {
	const body = composeBody[messageId] ?? '';
	if (body.trim().length === 0) return;
	actionInProgress.value = messageId;
	try {
		const result = await composeAndSend(messageId, body, composeSubject[messageId]);
		if (result === undefined) return;
		delete composeBody[messageId];
		delete composeSubject[messageId];
		showToast('Reply sent');
	} finally {
		actionInProgress.value = null;
	}
};
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="flex items-center gap-4 mb-8">
			<NuxtLink
				to="/dashboard/inbox"
				class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
			</NuxtLink>
			<div>
				<h1 class="text-2xl font-semibold text-text-primary">Review Queue</h1>
				<p class="text-text-secondary mt-1">
					Agent-generated drafts and escalations waiting for your action.
				</p>
			</div>
			<!-- Focus: switch to the one-task-at-a-time card-stack flow. -->
			<button
				v-if="!focusMode && !isLoading && visibleRows.length > 0"
				type="button"
				class="ml-auto inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-md bg-brand text-white hover:bg-brand/90 transition-colors duration-(--motion-fast)"
				@click="focusMode = true"
			>
				<Icon name="lucide:target" class="w-4 h-4" />
				Focus
			</button>
		</div>

		<!-- Focus flow (the browse list below stays as the alternative). -->
		<ReviewFocusFlow v-if="focusMode" @exit="focusMode = false" />
		<template v-else>
			<!-- Keyboard hint: this queue is keyboard-first (j/k/Enter/a/e/x). -->
			<div
				v-if="visibleRows.length > 0"
				class="flex flex-wrap items-center gap-x-4 gap-y-1 mb-4 text-xs text-text-tertiary"
			>
				<span
					v-for="hint in REVIEW_SHORTCUT_GROUPS"
					:key="hint.label"
					class="inline-flex items-center gap-1"
				>
					<kbd
						v-for="k in hint.keys"
						:key="k"
						class="px-1.5 py-0.5 rounded border border-border-subtle bg-bg-surface font-mono text-[10px] text-text-secondary"
						>{{ k }}</kbd
					>
					<span>{{ hint.label }}</span>
				</span>
			</div>

			<!-- Loading -->
			<div v-if="isLoading" class="flex items-center justify-center py-16">
				<div class="flex flex-col items-center gap-3">
					<UiSpinner />
					<p class="text-text-secondary text-sm">Loading review queue...</p>
				</div>
			</div>

			<!-- Empty State -->
			<div
				v-else-if="visibleRows.length === 0"
				class="flex flex-col items-center justify-center py-16 text-center"
			>
				<UiIconBox
					icon="lucide:check-circle"
					size="xl"
					variant="success"
					rounded="full"
					class="mb-4"
				/>
				<p class="text-text-secondary font-medium">All caught up!</p>
				<p class="text-sm text-text-tertiary mt-1">No drafts need your review right now.</p>
			</div>

			<!-- Review Items — a keyboard-navigable listbox (j/k/Enter/1-9/a/e/s/x)
		     of shared agent task cards. -->
			<ul
				v-else
				ref="listboxEl"
				tabindex="0"
				role="listbox"
				aria-label="Review queue"
				:aria-activedescendant="activeRowId"
				class="space-y-4 outline-none focus-visible:ring-1 focus-visible:ring-brand/40 focus-visible:ring-inset rounded-lg"
				@keydown="onQueueKeydown"
			>
				<TaskCardShell
					v-for="(row, i) in visibleRows"
					:id="`review-row-${row._id}`"
					:key="row._id"
					as="li"
					role="option"
					:aria-selected="focusedIndex === i"
					:focused="focusedIndex === i"
				>
					<TaskContext :who="row.message.from" icon="lucide:mail">
						<template #meta>
							{{ formatCompactRelativeTime(row.message._creationTime) }}
							<template v-if="row.thread">
								&middot;
								<NuxtLink
									:to="`/dashboard/inbox/${row.thread._id}`"
									class="text-brand hover:underline"
								>
									View thread
								</NuxtLink>
							</template>
						</template>
						<!-- One roll-up trust chip (human language; reasons + raw numbers in
					     its popover) + the category chip. -->
						<template #trailing>
							<div v-if="row.message.classification" class="flex items-center gap-2">
								<InboxTrustChip
									:trust="rowTrust(row.message)"
									:extra-detail="rowTrustDetail(row.message)"
								/>
								<span class="text-xs px-2 py-0.5 rounded-full bg-brand-subtle text-brand">
									{{ row.message.classification.category }}
								</span>
							</div>
						</template>
					</TaskContext>

					<!-- The ask: subject + excerpt, with the muted one-line WHY the agent
				     held/escalated it (moved up from the old rationale block). -->
					<TaskAsk
						class="mt-3 mb-4"
						:ask="row.message.subject || undefined"
						:detail="row.message.textBody || '(No text content)'"
						:why="rowWhy(row.message)"
					/>

					<!-- Draftless escalation: compose a reply inline -->
					<template v-if="needsReply(row.message)">
						<div class="bg-warning/5 border border-warning/20 rounded-lg p-4 mb-4">
							<div class="flex items-center gap-2 mb-3">
								<Icon name="lucide:user-round" class="w-4 h-4 text-warning" />
								<p class="text-xs font-medium text-warning uppercase tracking-wider">
									Escalated — write a reply
								</p>
							</div>
							<input
								v-model="composeSubject[row.message._id]"
								type="text"
								class="input w-full text-sm mb-3"
								placeholder="Subject (optional)"
							/>
							<textarea
								v-model="composeBody[row.message._id]"
								rows="6"
								class="input w-full text-sm resize-y"
								placeholder="Type your reply…"
							/>
							<!-- Coach the ADMIN's own reply to a high-stakes escalation before
						     they send it. Advisory only — never rewrites the text. -->
							<PostboxCoachPanel
								:draft-text="composeBody[row.message._id] ?? ''"
								:enabled="aiEnabled"
								:thread-context="row.message.textBody ?? undefined"
							/>
						</div>

						<!-- What the agent had to work from (the WHY line above carries the
					     escalation reason). -->
						<InboxDecisionRationale
							:grounding-sources="row.message.groundingSources"
							class="mb-4"
						/>

						<!-- Actions -->
						<TaskActions
							primary-label="Send Reply"
							primary-icon="lucide:send"
							:primary-disabled="
								actionInProgress === row.message._id || !composeBody[row.message._id]?.trim()
							"
							skip-label="Dismiss"
							skip-destructive
							:skip-disabled="actionInProgress === row.message._id"
							@primary="onComposeSend(row.message._id)"
							@skip="onRejectClick(row.message._id)"
						>
							<NuxtLink
								v-if="row.thread"
								:to="`/dashboard/inbox/${row.thread._id}`"
								class="inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors duration-(--motion-fast)"
							>
								<Icon name="lucide:external-link" class="w-3 h-3" />
								Open thread
							</NuxtLink>
						</TaskActions>
					</template>

					<!-- Agent draft awaiting approval -->
					<template v-else>
						<!-- Multiple pickable draft options (low-confidence / low-quality cases) -->
						<InboxDraftOptions
							v-if="(row.message.draftOptions?.length ?? 0) > 1"
							:options="row.message.draftOptions ?? []"
							:model-value="selectedOption[row.message._id] ?? 0"
							class="mb-4"
							@update:model-value="selectedOption[row.message._id] = $event"
						/>

						<!-- Single agent draft -->
						<div v-else class="bg-brand-subtle/30 rounded-lg p-4 mb-4">
							<div class="flex items-center gap-2 mb-2">
								<Icon name="lucide:bot" class="w-4 h-4 text-brand" />
								<p class="text-xs font-medium text-brand uppercase tracking-wider">Agent Draft</p>
							</div>
							<p class="text-text-primary text-sm whitespace-pre-wrap">
								{{ row.message.draftResponse }}
							</p>

							<!-- Freeform whole-draft revise ("redo but decline politely"), streamed. -->
							<AiReviseBox
								v-if="aiEnabled && row.message.draftResponse"
								class="mt-3"
								surface="review"
								:ai-enabled="aiEnabled"
								:current-draft="row.message.draftResponse ?? ''"
								@apply="(text: string) => onReviseApply(row.message._id, text)"
							/>
						</div>

						<!-- One-tap "attach the right file?" when the inbound asked for a
					     document and a contact-scoped file matched. Advisory; the human
					     confirms — the agent never auto-attaches. -->
						<InboxAttachSuggestion
							v-if="(row.message.attachmentSuggestions?.candidates?.length ?? 0) > 0"
							:suggestions="row.message.attachmentSuggestions!"
							class="mb-4"
							@attach="(c) => onAttachSuggested(row.thread?._id, c)"
						/>

						<!-- What it was grounded in (the WHY line above carries the hold
					     reason; read-only) -->
						<InboxDecisionRationale
							:grounding-sources="row.message.groundingSources"
							class="mb-4"
						/>

						<!-- Actions -->
						<TaskActions
							primary-label="Approve & Send"
							primary-icon="lucide:check"
							:primary-disabled="actionInProgress === row.message._id"
							skip-label="Reject"
							skip-destructive
							:skip-disabled="actionInProgress === row.message._id"
							@primary="
								onApproveOptionClick(
									row.message._id,
									row.message.draftOptions,
									row.message.draftResponse
								)
							"
							@skip="onRejectClick(row.message._id)"
						>
							<NuxtLink
								v-if="row.thread"
								:to="`/dashboard/inbox/${row.thread._id}`"
								class="inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors duration-(--motion-fast)"
							>
								<Icon name="lucide:pencil" class="w-3 h-3" />
								Edit
							</NuxtLink>
						</TaskActions>
					</template>
				</TaskCardShell>
			</ul>
		</template>
	</div>
</template>
