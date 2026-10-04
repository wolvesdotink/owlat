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
import { useLocalized } from '~/composables/useLocalized';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import {
	GENERIC_TEAMMATE_NAME,
	isReplyCollision,
	replyCollisionToast,
	sendHoldReason,
} from '~/utils/replyCollision';
import { escalationTrustLabel, trustLabel, type TrustLabel } from '~/utils/trustLabel';
import type { AnswerCardControls } from '~/utils/answerCard';
import { authoredTextGaps, draftTextGapSegments } from '~/utils/answerDraft';

type ReviewEntry = FunctionReturnType<typeof api.inbox.queries.getReviewQueue>[number];

/**
 * A team-inbox item as an Answer-queue card: an agent draft waiting for
 * approval (Approve & send / Reject), or a draftless escalation the reviewer
 * answers inline. Everything the team Review Queue did survives — the
 * countdown undo on approve, the soft hold while a teammate is replying, the
 * honest "already handled" when someone got there first.
 *
 * An agent draft's `[[...]]` gaps are marked. While the draft is gap-guarded
 * Approve is held (the server refuses it, DRAFT_HAS_GAPS) and the card offers
 * the way to fill them: Answer mode on the thread, or, for an item with no
 * thread, the draft opened for editing on the card.
 *
 * Keyboard on the focused card: a = approve, x = reject, Enter = the primary
 * action, s = skip. Inert while typing.
 */
const props = defineProps<{ entry: ReviewEntry; controls: AnswerCardControls }>();

const { t, te } = useI18n();

// "Billing", not the stored enum "billing"; an unknown value renders as stored.
const categoryLabel = computed(() => {
	const category = props.entry.message.classification?.category;
	if (!category) return '';
	const key = `dashboard.inbox.detail.categories.${category}`;
	return capitalize(te(key) ? t(key) : category);
});

const collisionText = useLocalized();

const { needsReply, onApprove, onReject, undoApprove, composeAndSend } = useReviewQueue();
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

// The draft's `[[...]]` gaps, in the written part only, as `approveDraft`
// counts them. They hold Approve while the draft is stored gap-guarded. A
// backend that predates the guard stores none: an unsaved draft there is the
// agent's own text, so its gaps hold too; a saved edit is the reviewer's.
const draftSegments = computed(() => draftTextGapSegments(message.value.draftResponse ?? ''));
const draftGapCount = computed(() => draftSegments.value.filter((s) => s.gap).length);
const gapHeld = computed(
	() =>
		!draftless.value &&
		draftGapCount.value > 0 &&
		(message.value.isDraftGapGuarded ?? message.value.draftSavedAt === undefined)
);
const gapReason = computed(() =>
	t(
		props.entry.thread
			? 'components.agentTasks.reviewFocusFlow.gapsHeldThread'
			: 'components.agentTasks.reviewFocusFlow.gapsHeldHere',
		{ count: draftGapCount.value },
		draftGapCount.value
	)
);

// No thread, so no Answer mode: the gaps are filled on the card, and the text
// goes out the way a draftless reply does (`composeAndSend`).
const filling = ref(false);
const fillField = ref<HTMLTextAreaElement | null>(null);
const fillReasonId = useId();
const fillGapCount = computed(() =>
	filling.value ? authoredTextGaps(composeBody.value).length : 0
);
const fillReason = computed(() =>
	t(
		'components.postbox.postboxComposerFooter.gapsLeft',
		{ count: fillGapCount.value },
		fillGapCount.value
	)
);
async function startFill() {
	composeBody.value = message.value.draftResponse ?? '';
	filling.value = true;
	await nextTick();
	const first = authoredTextGaps(composeBody.value)[0];
	fillField.value?.focus();
	if (first) fillField.value?.setSelectionRange(first.start, first.end);
}
function cancelFill() {
	filling.value = false;
	composeBody.value = '';
}

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

/**
 * What an approve (or a reply sent through one) came back with: a teammate's
 * hold, a lost race, or the send, armed with its undo countdown while the
 * server holds it back (a reply typed on the card included). True when done.
 */
function settleSend(
	id: Id<'inboundMessages'>,
	result: unknown,
	outcome: 'approved' | 'sent',
	sentToast: string
): boolean {
	if (isReplyCollision(result)) {
		showToast(
			collisionText(replyCollisionToast(result.heldByName ?? t(GENERIC_TEAMMATE_NAME))),
			'error'
		);
		return false;
	}
	if (handledAlreadyHandled(result)) return false;
	const undo = approveUndoWindow(result);
	if (undo) {
		armApproveUndo({
			inboundMessageId: id,
			sendAt: undo.sendAt,
			onUndo: () => props.controls.undoSelf(),
		});
	} else {
		showToast(t(sentToast));
	}
	props.controls.complete(outcome, undo ? () => undoApproveInverse(id) : undefined);
	return true;
}

async function approve() {
	if (busy.value || isHeld.value || gapHeld.value) return;
	busy.value = true;
	try {
		const m = message.value;
		// The text on the card is the text that goes out: a reviewer's saved edit
		// included, whatever variants the agent once offered.
		const result = await onApprove(m._id);
		if (!result.ok) return;
		settleSend(
			m._id,
			result.result,
			'approved',
			'components.agentTasks.reviewFocusFlow.toasts.draftApproved'
		);
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
	if (busy.value || isHeld.value || fillGapCount.value > 0 || body.trim().length === 0) return;
	busy.value = true;
	try {
		const id = message.value._id;
		const result = await composeAndSend(id, body);
		if (!result.ok) return;
		if (
			!settleSend(
				id,
				result.result,
				'sent',
				'components.agentTasks.reviewFocusFlow.toasts.replySent'
			)
		)
			return;
		composeBody.value = '';
		filling.value = false;
	} finally {
		busy.value = false;
	}
}

// Editing happens where every reply is written: Answer mode on the thread.
function openThread() {
	if (props.entry.thread) props.controls.openAnswer();
}

function onKeydown(event: KeyboardEvent) {
	if (event.metaKey || event.ctrlKey || event.altKey) return;
	if (isEditableTarget(event.target)) return;
	const action = resolveReviewFocusKey(event.key, {
		currentKind: draftless.value ? 'reply' : 'draft_review',
		needsReply: draftless.value || filling.value,
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
// The way to fill the gaps leads while they hold Approve.
const primaryButton =
	'inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded bg-brand text-text-inverse hover:bg-brand/90 transition-colors duration-(--motion-fast)';
</script>

<template>
	<TaskCardShell>
		<TaskContext :who="message.from" icon="lucide:mail">
			<template #trailing>
				<div v-if="message.classification" class="flex items-center gap-2">
					<InboxTrustChip :trust="trust" />
					<span class="text-xs px-2 py-0.5 rounded-full bg-brand-subtle text-brand">
						{{ categoryLabel }}
					</span>
				</div>
			</template>
		</TaskContext>

		<TaskAsk
			class="mt-3 mb-4"
			:ask="message.subject || undefined"
			:detail="
				message.textBody ||
				message.bodyExcerpt ||
				t('components.agentTasks.reviewFocusFlow.noTextContent')
			"
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

		<!-- Agent draft with its gaps filled on the card (no thread to edit it in) -->
		<template v-else-if="filling">
			<textarea
				ref="fillField"
				v-model="composeBody"
				rows="8"
				class="input w-full text-sm resize-y mb-4"
				:aria-label="t('components.agentTasks.reviewFocusFlow.fillLabel')"
				:aria-describedby="fillGapCount > 0 ? fillReasonId : undefined"
				data-testid="team-card-fill"
			/>
			<TaskActions
				:primary-label="t('components.agentTasks.reviewFocusFlow.sendReply')"
				primary-icon="lucide:send"
				:primary-disabled="busy || !composeBody.trim()"
				:primary-loading="busy"
				:held="isHeld || fillGapCount > 0"
				:held-reason="heldReason ?? fillReason"
				:held-reason-id="fillReasonId"
				:skip-label="t('components.agentTasks.reviewFocusFlow.reject')"
				skip-destructive
				:skip-disabled="busy"
				@primary="sendReply"
				@skip="reject"
			>
				<button type="button" :class="secondaryButton" :disabled="busy" @click="cancelFill">
					{{ t('common.cancel') }}
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
				</div>
				<p class="text-text-primary text-sm whitespace-pre-wrap" data-testid="team-card-draft">
					<template v-for="(segment, i) in draftSegments" :key="i"
						><mark
							v-if="segment.gap"
							class="owlat-draft-gap rounded-sm"
							data-testid="team-card-gap"
							>{{ segment.text }}</mark
						><template v-else>{{ segment.text }}</template></template
					>
				</p>
			</div>
			<InboxDecisionRationale :grounding-sources="message.groundingSources" class="mb-4" />
			<TaskActions
				:primary-label="t('components.agentTasks.reviewFocusFlow.reviewAndSend')"
				primary-icon="lucide:check"
				:primary-disabled="busy"
				:primary-loading="busy"
				:quiet="gapHeld"
				:held="isHeld || gapHeld"
				:held-reason="heldReason ?? (gapHeld ? gapReason : undefined)"
				:skip-label="t('components.agentTasks.reviewFocusFlow.reject')"
				skip-destructive
				:skip-disabled="busy"
				:hints="
					gapHeld
						? undefined
						: [{ keys: ['a'], label: t('components.agentTasks.reviewFocusFlow.reviewAndSend') }]
				"
				@primary="approve"
				@skip="reject"
			>
				<button
					v-if="entry.thread"
					type="button"
					:class="gapHeld ? primaryButton : secondaryButton"
					@click="openThread"
				>
					<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
					{{ t('components.agentTasks.reviewFocusFlow.editInThread') }}
				</button>
				<button
					v-else-if="gapHeld"
					type="button"
					:class="primaryButton"
					data-testid="team-card-fill-gaps"
					@click="startFill"
				>
					<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
					{{ t('components.agentTasks.reviewFocusFlow.fillGaps') }}
				</button>
			</TaskActions>
		</template>
	</TaskCardShell>
</template>
