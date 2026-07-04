<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { REVIEW_SHORTCUT_GROUPS } from '~/utils/reviewShortcuts';

useHead({ title: 'Review Queue — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'inbox',
});

const { reviewItems, isLoading, needsReply, onApprove, approveOption, onReject, composeAndSend } = useReviewQueue();

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
	})),
);

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
	currentDraft: string | null | undefined,
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
					row.message.draftResponse,
				),
	onEdit: openThread,
	onReject: (row) => void onRejectClick(row.message._id),
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
		</div>

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
			<UiIconBox icon="lucide:check-circle" size="xl" variant="success" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">All caught up!</p>
			<p class="text-sm text-text-tertiary mt-1">
				No drafts need your review right now.
			</p>
		</div>

		<!-- Review Items — a keyboard-navigable listbox (j/k/Enter/a/e/x). -->
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
			<li
				v-for="(row, i) in visibleRows"
				:id="`review-row-${row._id}`"
				:key="row._id"
				role="option"
				:aria-selected="focusedIndex === i"
				class="card"
				:class="focusedIndex === i ? 'ring-2 ring-brand/60' : ''"
			>
				<div class="flex items-start justify-between mb-3">
					<div class="flex items-center gap-3">
						<UiIconBox icon="lucide:mail" size="sm" variant="surface" rounded="full" />
						<div>
							<p class="text-text-primary font-medium text-sm">
								{{ row.message.from }}
							</p>
							<p class="text-xs text-text-tertiary">
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
							</p>
						</div>
					</div>

					<!-- Classification badges -->
					<div v-if="row.message.classification" class="flex items-center gap-2">
						<span
							v-if="needsReply(row.message)"
							class="text-xs px-2 py-0.5 rounded-full bg-warning/10 text-warning font-medium"
						>
							Needs reply
						</span>
						<span class="text-xs px-2 py-0.5 rounded-full bg-brand-subtle text-brand">
							{{ row.message.classification.category }}
						</span>
						<span class="text-xs px-2 py-0.5 rounded-full bg-bg-surface text-text-secondary font-mono">
							{{ Math.round((row.message.classification.confidence ?? 0) * 100) }}%
						</span>
					</div>
				</div>

				<!-- Original message excerpt -->
				<p v-if="row.message.subject" class="text-text-primary font-medium text-sm mb-1">
					{{ row.message.subject }}
				</p>
				<p class="text-text-secondary text-sm mb-4 line-clamp-2">
					{{ row.message.textBody || '(No text content)' }}
				</p>

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

					<!-- Why it was escalated + what the agent had to work from -->
					<InboxDecisionRationale
						:decision="row.message.agentDecision"
						:grounding-sources="row.message.groundingSources"
						class="mb-4"
					/>

					<!-- Actions -->
					<div class="flex items-center gap-2">
						<button
							class="btn btn-primary btn-sm gap-1"
							:disabled="actionInProgress === row.message._id || !(composeBody[row.message._id]?.trim())"
							@click="onComposeSend(row.message._id)"
						>
							<Icon name="lucide:send" class="w-3 h-3" />
							Send Reply
						</button>
						<NuxtLink
							v-if="row.thread"
							:to="`/dashboard/inbox/${row.thread._id}`"
							class="btn btn-secondary btn-sm gap-1"
						>
							<Icon name="lucide:external-link" class="w-3 h-3" />
							Open thread
						</NuxtLink>
						<button
							class="btn btn-ghost btn-sm gap-1 text-error hover:bg-error-subtle"
							:disabled="actionInProgress === row.message._id"
							@click="onRejectClick(row.message._id)"
						>
							<Icon name="lucide:x" class="w-3 h-3" />
							Dismiss
						</button>
					</div>
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
					</div>

					<!-- Why it was held + what it was grounded in (read-only) -->
					<InboxDecisionRationale
						:decision="row.message.agentDecision"
						:grounding-sources="row.message.groundingSources"
						class="mb-4"
					/>

					<!-- Actions -->
					<div class="flex items-center gap-2">
						<button
							class="btn btn-primary btn-sm gap-1"
							:disabled="actionInProgress === row.message._id"
							@click="onApproveOptionClick(row.message._id, row.message.draftOptions, row.message.draftResponse)"
						>
							<Icon name="lucide:check" class="w-3 h-3" />
							Approve & Send
						</button>
						<NuxtLink
							v-if="row.thread"
							:to="`/dashboard/inbox/${row.thread._id}`"
							class="btn btn-secondary btn-sm gap-1"
						>
							<Icon name="lucide:pencil" class="w-3 h-3" />
							Edit
						</NuxtLink>
						<button
							class="btn btn-ghost btn-sm gap-1 text-error hover:bg-error-subtle"
							:disabled="actionInProgress === row.message._id"
							@click="onRejectClick(row.message._id)"
						>
							<Icon name="lucide:x" class="w-3 h-3" />
							Reject
						</button>
					</div>
				</template>
			</li>
		</ul>
	</div>
</template>
