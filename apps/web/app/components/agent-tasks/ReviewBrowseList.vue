<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import ReviewBrowseCard from '~/components/agent-tasks/ReviewBrowseCard.vue';
import ReviewBulkActionBar from '~/components/agent-tasks/ReviewBulkActionBar.vue';
import ReviewQueueHeader from '~/components/agent-tasks/ReviewQueueHeader.vue';
import TaskCardShell from '~/components/agent-tasks/TaskCardShell.vue';
import {
	GENERIC_TEAMMATE_NAME,
	isReplyCollision,
	replyCollisionToast,
} from '~/utils/replyCollision';
import type { ReviewRow } from '~/utils/reviewRow';

/**
 * The Review Queue's keyboard-first browse view: a listbox of shared agent task
 * cards (trust chips, revise box, draft options, coach panel — each card's
 * anatomy lives in ReviewBrowseCard) with multi-select bulk approve/reject
 * (piece C2). Split out of review.vue so the page just switches between this
 * and the Focus card-stack flow (ReviewFocusFlow). Emits `focus` when the
 * reviewer opens the focused one-task-at-a-time flow instead.
 */
const emit = defineEmits<{ (e: 'focus'): void }>();

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
	showToast(
		t('components.agentTasks.reviewBrowseList.toasts.suggestedAttachment', {
			filename: candidate.filename,
		})
	);
	if (threadId) {
		navigateTo(`/dashboard/inbox/${threadId}`);
	}
}

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
// message + thread for rendering and navigation (the row TYPE lives in
// `~/utils/reviewRow`, shared with the card component).
const rows = computed<ReviewRow[]>(() =>
	(reviewItems.value ?? []).map((it) => ({
		_id: it.message._id,
		message: it.message,
		thread: it.thread,
	}))
);

// Optimistic row removal — approve/reject hide the row immediately and the live
// subscription confirms it; a failed action restores the row (usePostboxOptimisticHide).
const { visible: visibleRows, hide: hideRow, unhide: unhideRow } = usePostboxOptimisticHide(rows);

// Multi-select + bulk approve/reject (piece C2): a selection Set in the
// Postbox bulk idiom, the sticky action bar above the listbox, and batch
// mutations whose per-id outcomes drive one shared partial-result undo toast.
const bulk = useReviewBulkSelect(visibleRows);
const bulkActions = useReviewBulkActions({
	ids: bulk.ids,
	clearSelection: bulk.clear,
	hideRow,
	unhideRow,
});

// Server refused because a teammate just replied — toast the collision and
// report it handled so callers stop before claiming a false success.
function handledReplyCollision(result: unknown): boolean {
	if (!isReplyCollision(result)) return false;
	showToast(
		collisionText(replyCollisionToast(result.heldByName ?? t(GENERIC_TEAMMATE_NAME))),
		'error'
	);
	return true;
}

// Countdown-undo toast for approvals inside their server-side undo window
// (agentConfig.humanApproveUndoDelayMs, piece C1). Armed with this list's true
// inverse: undoAutoSend routes the draft back to `draft_ready` and the row is
// unhidden immediately rather than waiting on the live subscription round-trip.
const { arm: armApproveUndo } = useReviewApproveUndo();

async function undoApproveAndRestore(messageId: Id<'inboundMessages'>) {
	const result = await undoApprove(messageId);
	if (result === undefined) return; // categorized failure — already toasted
	if (result.cancelled) {
		unhideRow(messageId);
		showToast(t('shared.reviewBulkSummary.undoneOne'));
	} else {
		// The window closed while the toast was up — the send already left.
		showToast(t('shared.reviewBulkSummary.tooLateOne'), 'warning');
	}
}

// Shared optimistic row action: hide the row, run the mutation, restore it on a
// no-op or soft collision (reject never collides), else confirm with successMsg.
// An approve that returns an open undo window arms the countdown-undo toast
// instead of the plain confirmation.
async function runOptimistic(
	messageId: Id<'inboundMessages'>,
	send: () => Promise<unknown>,
	successMsg = t('components.agentTasks.reviewBrowseList.toasts.draftApproved')
) {
	actionInProgress.value = messageId;
	hideRow(messageId);
	try {
		const result = await send();
		if (result === undefined || handledReplyCollision(result)) {
			unhideRow(messageId);
			return;
		}
		const undo = approveUndoWindow(result);
		if (undo) {
			armApproveUndo({
				inboundMessageId: messageId,
				sendAt: undo.sendAt,
				onUndo: () => undoApproveAndRestore(messageId),
			});
		} else {
			showToast(successMsg);
		}
	} finally {
		actionInProgress.value = null;
	}
}

const onApproveClick = (messageId: Id<'inboundMessages'>) =>
	runOptimistic(messageId, () => onApprove(messageId));

// Approve the selected draft option (multi-option cards); falls back to the
// plain approve when no options were offered — same undo-guarded send.
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
	await runOptimistic(messageId, () => approveOption(messageId, chosen, currentDraft));
};

const onRejectClick = (messageId: Id<'inboundMessages'>) =>
	runOptimistic(
		messageId,
		() => onReject(messageId),
		t('components.agentTasks.reviewBrowseList.toasts.draftRejected')
	);

// Keyboard-first triage: j/k move, Enter opens the thread, a approves (through
// the SAME undo-guarded send the button calls), e edits, # rejects — plus the
// C2 selection layer (Space/x select, Shift+J/K extend, * select-all-visible).
// Built by reusing the Postbox house composables; keys stay inert while the
// inline compose input/textarea is focused.
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
	// Space/x toggle, Shift+J/K range-extend, * select-all — the bulk model.
	selection: {
		toggle: (row) => bulk.toggle(row._id),
		selectMany: (rowsToSelect) => bulk.selectMany(rowsToSelect.map((r) => r._id)),
		selectAllVisible: () => bulk.selectAllVisible(),
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
		if (result === undefined || handledReplyCollision(result)) return; // no-op or collision
		delete composeBody[messageId];
		delete composeSubject[messageId];
		showToast(t('components.agentTasks.reviewBrowseList.toasts.replySent'));
	} finally {
		actionInProgress.value = null;
	}
};
</script>

<template>
	<div>
		<ReviewQueueHeader :has-rows="!isLoading && visibleRows.length > 0" @focus="emit('focus')" />

		<!-- Loading -->
		<div v-if="isLoading" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">
					{{ t('components.agentTasks.reviewBrowseList.loading') }}
				</p>
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
			<p class="text-text-secondary font-medium">
				{{ t('components.agentTasks.reviewBrowseList.empty.title') }}
			</p>
			<p class="text-sm text-text-tertiary mt-1">
				{{ t('components.agentTasks.reviewBrowseList.empty.body') }}
			</p>
		</div>

		<template v-else>
			<!-- Sticky bulk bar: appears with the first selected card. -->
			<ReviewBulkActionBar
				:count="bulk.count.value"
				:remaining="visibleRows.length - bulk.count.value"
				:busy="bulkActions.isBusy.value"
				@approve="bulkActions.approveSelected()"
				@reject="bulkActions.rejectSelected()"
				@select-all="bulk.selectAllVisible()"
				@clear="bulk.clear()"
			/>

			<!-- Review Items — a keyboard-navigable listbox (j/k/Enter/1-9/a/e/s/#, Space/x/J/K/* select) of shared agent task cards. -->
			<ul
				ref="listboxEl"
				tabindex="0"
				role="listbox"
				:aria-label="t('components.agentTasks.reviewBrowseList.listLabel')"
				aria-multiselectable="true"
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
					:aria-selected="bulk.isSelected(row._id)"
					:focused="focusedIndex === i"
					:class="bulk.isSelected(row._id) ? 'ring-1 ring-brand/50' : ''"
				>
					<ReviewBrowseCard
						v-model:selected-option="selectedOption[row.message._id]"
						v-model:compose-subject="composeSubject[row.message._id]"
						v-model:compose-body="composeBody[row.message._id]"
						:row="row"
						:needs-reply="needsReply(row.message)"
						:ai-enabled="aiEnabled"
						:busy="actionInProgress === row.message._id"
						:selected="bulk.isSelected(row._id)"
						@toggle-select="bulk.toggle(row._id)"
						@revise-apply="(text: string) => onReviseApply(row.message._id, text)"
						@attach="(candidate) => onAttachSuggested(row.thread?._id, candidate)"
						@approve="
							onApproveOptionClick(
								row.message._id,
								row.message.draftOptions,
								row.message.draftResponse
							)
						"
						@reject="onRejectClick(row.message._id)"
						@compose-send="onComposeSend(row.message._id)"
					/>
				</TaskCardShell>
			</ul>
		</template>
	</div>
</template>
