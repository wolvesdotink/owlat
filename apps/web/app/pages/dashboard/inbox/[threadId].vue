<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { useOrganization } from '~/composables/useOrganization';
import {
	GENERIC_TEAMMATE_NAME,
	isReplyCollision,
	replyCollisionToast,
	sendHoldReason,
} from '~/utils/replyCollision';

const { t, te } = useI18n();

useHead({ title: () => t('dashboard.inbox.detail.pageTitle') });

/**
 * Collision copy lives in utils/replyCollision as an i18n key + params (the
 * registry convention for module-scope definitions); the string form is still
 * accepted so a plain sentence renders as itself.
 */
type CollisionMessage = string | { key: string; params?: Record<string, unknown> };
function collisionText(message: CollisionMessage): string {
	return typeof message === 'string' ? t(message) : t(message.key, message.params ?? {});
}

// Classification / processing labels are translated here; the backend enums stay
// the source of truth, so an unrecognised value renders as stored.
const classificationLabel = (group: string, value: string): string => {
	const key = `dashboard.inbox.detail.${group}.${value}`;
	return te(key) ? t(key) : value;
};

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'inbox',
});

const threadId = useRouteId<'conversationThreads'>('threadId');

const {
	thread,
	messages,
	contact,
	threadLoading,
	isEditingDraft,
	editedDraftResponse,
	editedDraftSubject,
	handleApprove,
	handleReject,
	handleRetry,
	startEditDraft,
	cancelEditDraft,
	saveEditedDraft,
	saveDraftOnly,
	handleStatusChange,
	handleSnooze,
	handleUnsnooze,
	getProcessingStatusColor,
	getProcessingStatusLabel,
	getCategoryIcon,
	formatTimestamp,
	handleAssign,
} = useThreadDetail(threadId);

// Snooze picker — reuses the Postbox snooze presets (PostboxSnoozeDialog).
const showSnoozeDialog = ref(false);
const isSnoozed = computed(
	() => !!thread.value?.snoozedUntil && thread.value.snoozedUntil > Date.now()
);

// Org members for the assignee picker (shared-inbox team triage).
const { members, fetchMembers } = useOrganization();
const { user } = useAuth();
const { isAdmin } = usePermissions();
onMounted(() => {
	void fetchMembers();
});

// Members projected for the avatar picker.
const assignMembers = computed(() =>
	members.value.map((m) => ({
		userId: m.userId,
		name: m.user.name,
		email: m.user.email,
		image: m.user.image,
	}))
);
const onAssign = (assignedTo: string | undefined) => {
	void handleAssign(assignedTo);
};
// `i` anywhere on the thread claims it for me — mirrors the list shortcut.
const assignToMe = () => {
	const me = user.value?.id;
	if (me) void handleAssign(me);
};
function onThreadKeydown(event: KeyboardEvent) {
	if (event.key !== 'i' && event.key !== 'I') return;
	if (event.metaKey || event.ctrlKey || event.altKey) return;
	const target = event.target as HTMLElement | null;
	// Never hijack typing in an input / textarea / contenteditable.
	if (
		target &&
		(target.isContentEditable ||
			target.tagName === 'INPUT' ||
			target.tagName === 'TEXTAREA' ||
			target.tagName === 'SELECT')
	) {
		return;
	}
	event.preventDefault();
	assignToMe();
}
onMounted(() => window.addEventListener('keydown', onThreadKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onThreadKeydown));

// Mark the thread seen for THIS user (per-user unread, mirroring chat's
// lastReadAt) on open and whenever we navigate to another thread. Best-effort:
// a failed mark just leaves the row bold until the next open.
const { run: markThreadSeen } = useBackendOperation(api.inbox.reads.markThreadSeen, {
	label: () => t('dashboard.inbox.detail.markSeenOperation'),
});
const markSeen = () => {
	void markThreadSeen({ threadId: threadId.value });
};
onMounted(markSeen);
watch(threadId, markSeen);
const assignedMemberName = computed(() => {
	const id = thread.value?.assignedTo;
	if (!id) return null;
	const m = members.value.find((x) => x.userId === id);
	return m ? m.user.name || m.user.email : id;
});

// Live thread presence — heartbeat while this thread is open, flip to "replying"
// while the draft editor is active. `others` excludes the current user; resolve
// each to a display name/avatar via the already-fetched org members.
const { others: presenceOthers } = useThreadPresence(threadId, { replying: isEditingDraft });
const presencePeople = computed(() =>
	presenceOthers.value.map((p) => {
		const m = members.value.find((x) => x.userId === p.userId);
		return {
			userId: p.userId,
			mode: p.mode,
			name: m ? m.user.name || m.user.email : t('dashboard.inbox.detail.someone'),
			image: m?.user.image ?? null,
		};
	})
);

// Collision soft-hold: while another teammate is actively replying to THIS
// thread, hold the send/approve controls (disabled-styled but visible) so we
// don't double-answer. Never a lock — it releases on its own when their
// `replying` presence expires or drops. The `approveDraft` mutation re-checks
// server-side as a belt-and-braces guard (see utils/replyCollision.ts).
const heldByReplierName = computed(() => {
	const r = presencePeople.value.find((p) => p.mode === 'replying');
	return r ? r.name : null;
});
const isHeld = computed(() => heldByReplierName.value !== null);
const holdReason = computed(() =>
	isHeld.value && heldByReplierName.value
		? collisionText(sendHoldReason(heldByReplierName.value))
		: undefined
);

// Actions state
const isApproving = ref(false);
const isRejecting = ref(false);
const isSavingEdit = ref(false);
const isRetrying = ref(false);
const rejectReason = ref('');
const showRejectModal = ref(false);
const actionMessageId = ref<Id<'inboundMessages'> | null>(null);
const clarificationAnswers = reactive<Record<string, Record<string, string>>>({});
const now = ref(Date.now());
let countdownTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
	countdownTimer = setInterval(() => {
		now.value = Date.now();
	}, 250);
});
onBeforeUnmount(() => {
	if (countdownTimer) clearInterval(countdownTimer);
});

const { run: answerClarification, isLoading: isAnsweringClarification } = useBackendOperation(
	api.inbox.clarification.answerClarification,
	{ label: () => t('dashboard.inbox.detail.answerClarificationOperation') }
);
const { run: undoAutoSend, isLoading: isUndoingAutoSend } = useBackendOperation(
	api.inbox.mutations.undoAutoSend,
	{ label: () => t('dashboard.inbox.detail.undoAutoSendOperation') }
);

function setClarificationAnswer(messageId: string, questionId: string, value: string) {
	const answers = (clarificationAnswers[messageId] ??= {});
	answers[questionId] = value;
}

function hasEveryClarificationAnswer(message: NonNullable<typeof messages.value>[number]) {
	const answers = clarificationAnswers[message._id] ?? {};
	return (
		(message.pendingClarification?.questions.length ?? 0) > 0 &&
		message.pendingClarification?.questions.every((question) => answers[question.id]?.trim())
	);
}

async function submitClarification(message: NonNullable<typeof messages.value>[number]) {
	if (!isAdmin.value) return;
	const questions = message.pendingClarification?.questions ?? [];
	const values = clarificationAnswers[message._id] ?? {};
	const result = await answerClarification({
		inboundMessageId: message._id,
		answers: questions.map((question) => ({
			questionId: question.id,
			value: values[question.id]?.trim() ?? '',
		})),
	});
	if (result.ok) showToast(t('dashboard.inbox.detail.clarificationSavedToast'));
}

async function cancelAutoSend(messageId: Id<'inboundMessages'>) {
	if (!isAdmin.value) return;
	const result = await undoAutoSend({ inboundMessageId: messageId });
	if (result.ok && result.result.cancelled)
		showToast(t('dashboard.inbox.detail.autoSendCancelledToast'));
}

const remainingAutoSendSeconds = (sendAt: number) =>
	Math.max(0, Math.ceil((sendAt - now.value) / 1000));

// Use the shared global toast. The underlying actions go through
// useBackendOperation, which already toasts any categorized failure — so we
// only emit the success toast here, and only when the operation truly
// succeeded (run resolves to `ok: false` on failure, never throws).
const { showToast } = useToast();

const onSnoozeConfirm = async (timestamp: number) => {
	showSnoozeDialog.value = false;
	const result = await handleSnooze(timestamp);
	if (result.ok) showToast(t('dashboard.inbox.detail.snoozedToast'));
};
// "Until they reply" maps to a capped snooze: an inbound reply already
// resurfaces a snoozed thread (the thread module's inbound_activity reducer
// clears the snooze), so the cap is just the no-reply fallback.
const onSnoozeUntilReply = async (capTimestamp: number) => {
	showSnoozeDialog.value = false;
	const result = await handleSnooze(capTimestamp);
	if (result.ok) showToast(t('dashboard.inbox.detail.snoozedUntilReplyToast'));
};
const onUnsnooze = async () => {
	const result = await handleUnsnooze();
	if (result.ok) showToast(t('dashboard.inbox.detail.unsnoozedToast'));
};

const onApprove = async (messageId: Id<'inboundMessages'>) => {
	if (isHeld.value) return;
	isApproving.value = true;
	try {
		const result = await handleApprove(messageId);
		if (!result.ok) return;
		// Server refused because a teammate just replied — toast, don't claim success.
		if (isReplyCollision(result.result)) {
			showToast(
				collisionText(replyCollisionToast(result.result.heldByName ?? t(GENERIC_TEAMMATE_NAME))),
				'error'
			);
			return;
		}
		showToast(t('dashboard.inbox.detail.draftApprovedToast'));
	} finally {
		isApproving.value = false;
	}
};

const openRejectModal = (messageId: Id<'inboundMessages'>) => {
	actionMessageId.value = messageId;
	rejectReason.value = '';
	showRejectModal.value = true;
};

const onReject = async () => {
	if (!actionMessageId.value) return;
	isRejecting.value = true;
	try {
		const result = await handleReject(actionMessageId.value, rejectReason.value || undefined);
		if (result.ok) {
			showRejectModal.value = false;
			showToast(t('dashboard.inbox.detail.draftRejectedToast'));
		}
	} finally {
		isRejecting.value = false;
	}
};

const onRetry = async (messageId: Id<'inboundMessages'>) => {
	isRetrying.value = true;
	try {
		const result = await handleRetry(messageId);
		if (result.ok) showToast(t('dashboard.inbox.detail.retriedToast'));
	} finally {
		isRetrying.value = false;
	}
};

const onSaveEdit = async (messageId: Id<'inboundMessages'>) => {
	if (isHeld.value) return;
	isSavingEdit.value = true;
	try {
		const result = await saveEditedDraft(messageId);
		if (!result.ok) return;
		// Server refused because a teammate just replied — toast, don't claim success.
		if (isReplyCollision(result.result)) {
			showToast(
				collisionText(replyCollisionToast(result.result.heldByName ?? t(GENERIC_TEAMMATE_NAME))),
				'error'
			);
			return;
		}
		showToast(t('dashboard.inbox.detail.draftSavedToast'));
	} finally {
		isSavingEdit.value = false;
	}
};

// Inline Save (piece D1'): persist the edit as a draft revision WITHOUT
// approving. The message stays in the review queue ("Saved · edited by you");
// no collision hold applies because nothing is sent.
const onSaveOnly = async (messageId: Id<'inboundMessages'>) => {
	isSavingEdit.value = true;
	try {
		const result = await saveDraftOnly(messageId);
		if (!result.ok) return;
		showToast(t('dashboard.inbox.detail.toasts.draftSavedNotApproved'));
	} finally {
		isSavingEdit.value = false;
	}
};

// The diff's "before" side is the AGENT's original draft (revision 0), not the
// latest saved text — otherwise the first save would destroy the agent-vs-human
// diff. Falls back to the working draft for messages never saved.
const agentOriginalDraft = (message: NonNullable<typeof messages.value>[number]) => {
	const original = message.draftRevisions?.[0];
	return original?.savedBy === 'agent' ? original.text : (message.draftResponse ?? '');
};

// `closed` is merged into `resolved` in the UI — the picker no longer offers it
// (legacy closed threads still read "Resolved" via the shared status chip).
const statusOptions = ['open', 'waiting', 'resolved'] as const;

// Chat integration: surface existing chat channels that already discuss this
// thread, and offer to spin up a new one. Only active when the chat flag is
// enabled — the query throws FEATURE_DISABLED otherwise.
const { isEnabled: isFeatureEnabled } = useFeatureFlag();
const chatEnabled = computed(() => isFeatureEnabled('chat'));

const { data: discussionChannelsData } = useConvexQuery(
	api.chat.emailLink.findChannelsForInboxThread,
	() => (chatEnabled.value ? { inboxThreadId: threadId.value } : 'skip')
);
const discussionChannels = computed(() => discussionChannelsData.value ?? []);

const showNewChannel = ref(false);
const router = useRouter();
const { linkChannelToInboxThread } = useChatActions();
const onChannelCreated = async (roomId: Id<'chatRooms'>) => {
	// Channel was just created — link it to this inbox thread, then jump.
	// run() toasts its own failure and resolves `ok: false`; only navigate into
	// the channel when the link actually persisted.
	const result = await linkChannelToInboxThread(roomId, threadId.value);
	showNewChannel.value = false;
	if (!result.ok) {
		showToast(t('dashboard.inbox.detail.channelLinkFailedToast'), 'error');
		return;
	}
	router.push(`/dashboard/chat/${roomId}`);
};
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Back Navigation -->
		<NuxtLink
			to="/dashboard/inbox"
			class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors mb-6"
		>
			<Icon name="lucide:arrow-left" class="w-4 h-4" />
			{{ t('dashboard.inbox.detail.backToInbox') }}
		</NuxtLink>

		<!-- Loading -->
		<div v-if="threadLoading && !thread" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">{{ t('dashboard.inbox.detail.loading') }}</p>
			</div>
		</div>

		<!-- Not Found -->
		<div v-else-if="!thread" class="flex flex-col items-center justify-center py-16 text-center">
			<UiIconBox
				icon="lucide:alert-circle"
				size="xl"
				variant="surface"
				rounded="full"
				class="mb-4"
			/>
			<p class="text-text-secondary font-medium">{{ t('dashboard.inbox.detail.notFound') }}</p>
			<UiButton variant="secondary" to="/dashboard/inbox" class="mt-6">
				{{ t('dashboard.inbox.detail.backToInbox') }}
			</UiButton>
		</div>

		<!-- Thread Content -->
		<template v-else>
			<!-- Header -->
			<div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-6">
				<div>
					<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
						{{ thread.subject || t('dashboard.inbox.detail.noSubject') }}
					</h1>
					<div class="flex items-center gap-3 mt-2">
						<InboxStatusChip
							:status="thread.status"
							:latest-draft-status="thread.latestDraftStatus"
							:snoozed-until="thread.snoozedUntil"
							:snooze-returned-at="thread.snoozeReturnedAt"
						/>
						<span v-if="contact" class="text-sm text-text-secondary">
							{{ contact.email }}
						</span>
						<span class="text-sm text-text-tertiary">
							{{ t('dashboard.inbox.detail.messageCount', { count: thread.messageCount ?? 0 }) }}
						</span>
					</div>
					<!-- Who else is here — pulsing viewer ring + "is replying" banner -->
					<InboxThreadPresence :people="presencePeople" class="mt-3" />
				</div>

				<!-- Status actions -->
				<div class="flex items-center gap-2">
					<div v-if="chatEnabled" class="flex items-center gap-1">
						<NuxtLink
							v-for="channel in discussionChannels"
							:key="channel._id"
							:to="`/dashboard/chat/${channel._id}`"
							class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-brand-subtle text-brand hover:bg-brand-subtle/70 transition-colors"
							:title="t('dashboard.inbox.detail.discussInChannelTitle', { channel: channel.name })"
						>
							<Icon name="lucide:message-circle" class="w-3.5 h-3.5" />
							#{{ channel.name }}
						</NuxtLink>
						<UiButton
							v-if="discussionChannels.length === 0"
							variant="outline"
							size="sm"
							@click="showNewChannel = true"
						>
							<template #iconLeft>
								<Icon name="lucide:message-circle-plus" class="w-3.5 h-3.5" />
							</template>
							{{ t('dashboard.inbox.detail.discussInChannel') }}
						</UiButton>
					</div>
					<!-- Assignee picker — avatar popover (Me / members / Unassign). -->
					<InboxAssignPopover
						:members="assignMembers"
						:current-user-id="user?.id ?? null"
						:assigned-to="thread.assignedTo ?? null"
						position="right"
						@assign="onAssign"
					>
						<template #trigger>
							<UiButton
								variant="secondary"
								size="sm"
								type="button"
								class="gap-1.5"
								:aria-label="
									assignedMemberName
										? t('dashboard.inbox.detail.assignedToAria', { name: assignedMemberName })
										: t('dashboard.inbox.detail.assignThreadAria')
								"
							>
								<UiAvatar
									v-if="thread.assignedTo"
									:name="assignedMemberName ?? undefined"
									deterministic-color
									size="sm"
								/>
								<Icon v-else name="lucide:user-plus" class="w-4 h-4" />
								<span class="max-w-[10rem] truncate">
									{{ assignedMemberName ?? t('dashboard.inbox.detail.assign') }}
								</span>
							</UiButton>
						</template>
					</InboxAssignPopover>
					<!-- Snooze / unsnooze — reuses the Postbox snooze presets. -->
					<UiButton
						variant="secondary"
						size="sm"
						v-if="isSnoozed"
						class="gap-1.5"
						@click="onUnsnooze"
					>
						<Icon name="lucide:alarm-clock-off" class="w-4 h-4" />
						{{ t('dashboard.inbox.detail.unsnooze') }}
					</UiButton>
					<UiButton
						variant="secondary"
						size="sm"
						v-else
						class="gap-1.5"
						@click="showSnoozeDialog = true"
					>
						<Icon name="lucide:alarm-clock" class="w-4 h-4" />
						{{ t('dashboard.inbox.detail.snooze') }}
					</UiButton>
					<select
						:value="thread.status === 'closed' ? 'resolved' : thread.status"
						class="input w-auto text-sm"
						:aria-label="t('dashboard.inbox.detail.changeStatusAria')"
						@change="
							handleStatusChange(
								($event.target as HTMLSelectElement).value as 'open' | 'waiting' | 'resolved'
							)
						"
					>
						<option v-for="s in statusOptions" :key="s" :value="s">
							{{ t(`dashboard.inbox.detail.statuses.${s}`) }}
						</option>
					</select>
				</div>
			</div>

			<PostboxSnoozeDialog
				:open="showSnoozeDialog"
				:hint-text="thread.subject ?? ''"
				@update:open="showSnoozeDialog = $event"
				@confirm="onSnoozeConfirm"
				@confirm-until-reply="onSnoozeUntilReply"
			/>

			<ChatNewChannelDialog
				v-if="showNewChannel"
				@close="showNewChannel = false"
				@created="onChannelCreated"
			/>

			<div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
				<!-- Messages Timeline -->
				<div class="lg:col-span-2 space-y-4">
					<div v-for="message in messages" :key="message._id" class="card">
						<!-- Message Header -->
						<div class="flex items-center justify-between mb-4">
							<div class="flex items-center gap-3">
								<UiIconBox icon="lucide:mail" size="sm" variant="surface" rounded="full" />
								<div>
									<p class="text-text-primary font-medium text-sm">{{ message.from }}</p>
									<p class="text-xs text-text-tertiary">
										{{ formatTimestamp(message._creationTime) }}
									</p>
								</div>
							</div>
							<span
								class="text-xs px-2 py-0.5 rounded-full"
								:class="getProcessingStatusColor(message.processingStatus)"
							>
								{{ getProcessingStatusLabel(message.processingStatus) }}
							</span>
						</div>

						<!-- The mirror of the Postbox reader's strip (idea 31): this
						     message also sits in someone's personal mailbox, and it may
						     already have been answered there. Read-only; renders nothing
						     unless the viewer is permitted on both surfaces. -->
						<InboxCrossSurfaceStrip :inbound-message-id="message._id" class="mb-3" />

						<!-- Subject -->
						<p v-if="message.subject" class="text-text-primary font-medium mb-2">
							{{ message.subject }}
						</p>

						<!-- Message Body -->
						<div
							class="text-text-secondary text-sm whitespace-pre-wrap border-t border-border-subtle pt-4"
						>
							{{ message.textBody || t('dashboard.inbox.detail.noTextContent') }}
						</div>

						<!-- Classification -->
						<div v-if="message.classification" class="mt-4 p-3 bg-bg-surface rounded-lg">
							<p class="text-xs text-text-tertiary mb-2 font-medium uppercase tracking-wider">
								{{ t('dashboard.inbox.detail.aiClassification') }}
							</p>
							<div class="flex flex-wrap gap-2">
								<span
									class="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-brand-subtle text-brand"
								>
									<Icon :name="getCategoryIcon(message.classification.category)" class="w-3 h-3" />
									{{ classificationLabel('categories', message.classification.category) }}
								</span>
								<span class="text-xs px-2 py-1 rounded-full bg-bg-elevated text-text-secondary">
									{{
										t('dashboard.inbox.detail.priorityChip', {
											priority: classificationLabel('priorities', message.classification.priority),
										})
									}}
								</span>
								<span class="text-xs px-2 py-1 rounded-full bg-bg-elevated text-text-secondary">
									{{ classificationLabel('sentiments', message.classification.sentiment) }}
								</span>
								<span
									class="text-xs px-2 py-1 rounded-full bg-bg-elevated text-text-secondary font-mono"
								>
									{{
										t('dashboard.inbox.detail.confidenceChip', {
											percent: Math.round((message.classification.confidence ?? 0) * 100),
										})
									}}
								</span>
							</div>
						</div>

						<!-- Failure reason + manual retry (terminal 'failed' state) -->
						<div
							v-if="message.processingStatus === 'failed'"
							class="mt-4 p-3 bg-error-subtle rounded-lg"
						>
							<p class="text-xs text-error font-medium uppercase tracking-wider mb-2">
								{{ t('dashboard.inbox.detail.processingFailed') }}
							</p>
							<p v-if="message.errorMessage" class="text-sm text-text-primary break-words mb-3">
								{{ message.errorMessage }}
							</p>
							<p v-else class="text-sm text-text-secondary mb-3">
								{{ t('dashboard.inbox.detail.noErrorDetail') }}
							</p>
							<UiButton
								variant="secondary"
								size="sm"
								class="gap-1"
								:disabled="isRetrying"
								@click="onRetry(message._id)"
							>
								<Icon name="lucide:refresh-cw" class="w-3 h-3" />
								{{ t('dashboard.inbox.detail.retryProcessing') }}
							</UiButton>
						</div>

						<div
							v-if="
								isAdmin &&
								message.processingStatus === 'awaiting_clarification' &&
								message.pendingClarification
							"
							class="mt-4 rounded-lg border border-warning/30 bg-warning/5 p-4"
						>
							<div class="mb-3 flex items-center gap-2">
								<Icon name="lucide:message-circle-question" class="h-4 w-4 text-warning" />
								<p class="text-sm font-medium text-text-primary">
									{{ t('dashboard.inbox.detail.agentNeedsInput') }}
								</p>
							</div>
							<div class="space-y-3">
								<UiInput
									v-for="question in message.pendingClarification.questions"
									:key="question.id"
									:model-value="clarificationAnswers[message._id]?.[question.id] ?? ''"
									:label="question.text"
									:placeholder="
										question.options?.join(' / ') || t('dashboard.inbox.detail.answerPlaceholder')
									"
									@update:model-value="
										setClarificationAnswer(message._id, question.id, String($event))
									"
								/>
								<UiButton
									size="sm"
									:loading="isAnsweringClarification"
									:disabled="!hasEveryClarificationAnswer(message)"
									@click="submitClarification(message)"
								>
									{{ t('dashboard.inbox.detail.answerAndResume') }}
								</UiButton>
							</div>
						</div>

						<div
							v-if="
								isAdmin &&
								message.pendingAutoSend &&
								remainingAutoSendSeconds(message.pendingAutoSend.sendAt) > 0
							"
							class="mt-4 flex items-center justify-between gap-3 rounded-lg border border-brand/20 bg-brand-subtle/30 p-3"
						>
							<div class="flex items-center gap-2 text-sm text-text-primary">
								<Icon name="lucide:send" class="h-4 w-4 text-brand" />
								{{
									t('dashboard.inbox.detail.sendingAutomatically', {
										seconds: remainingAutoSendSeconds(message.pendingAutoSend.sendAt),
									})
								}}
							</div>
							<UiButton
								variant="secondary"
								size="sm"
								:loading="isUndoingAutoSend"
								@click="cancelAutoSend(message._id)"
							>
								{{ t('dashboard.inbox.detail.undo') }}
							</UiButton>
						</div>

						<!-- Agent processing trace -->
						<InboxAgentActionTimeline :inbound-message-id="message._id" />

						<!-- Draft Response -->
						<div
							v-if="message.draftResponse && message.processingStatus === 'draft_ready'"
							class="mt-4 border-t border-border-subtle pt-4"
						>
							<div class="flex items-center gap-2 mb-3">
								<Icon name="lucide:bot" class="w-4 h-4 text-brand" />
								<p class="text-sm font-medium text-brand">
									{{ t('dashboard.inbox.detail.agentDraft') }}
								</p>
							</div>

							<!-- Editing mode: edit with a live before/after diff so the
							     reviewer sees what changed before it becomes the outgoing
							     draft. Apply saves + approves; Discard reverts to the original. -->
							<template v-if="isEditingDraft">
								<div class="space-y-3">
									<input
										v-model="editedDraftSubject"
										type="text"
										class="input w-full text-sm"
										:placeholder="t('dashboard.inbox.detail.subjectPlaceholder')"
									/>
									<InboxDraftDiffEditor
										v-model="editedDraftResponse"
										:original="agentOriginalDraft(message)"
										:saving="isSavingEdit"
										:held="isHeld"
										:held-reason="holdReason"
										show-save
										@apply="onSaveEdit(message._id)"
										@save="onSaveOnly(message._id)"
										@discard="cancelEditDraft"
									/>
								</div>
							</template>

							<!-- View mode -->
							<template v-else>
								<div
									class="text-text-primary text-sm whitespace-pre-wrap bg-brand-subtle/30 rounded-lg p-4"
								>
									{{ message.draftResponse }}
								</div>

								<!-- Action Buttons -->
								<div class="flex items-center gap-2 mt-4">
									<UiButton
										size="sm"
										class="gap-1 disabled:cursor-not-allowed"
										:disabled="isApproving || isHeld"
										:aria-disabled="isHeld ? 'true' : undefined"
										@click="onApprove(message._id)"
									>
										<UiSpinner v-if="isApproving" size="xs" tone="inverse" />
										<Icon v-else name="lucide:check" class="w-3 h-3" />
										{{ t('dashboard.inbox.detail.approveAndSend') }}
									</UiButton>
									<UiButton
										variant="secondary"
										size="sm"
										class="gap-1"
										@click="startEditDraft(message)"
									>
										<Icon name="lucide:pencil" class="w-3 h-3" />
										{{ t('common.edit') }}
									</UiButton>
									<UiButton
										variant="ghost"
										size="sm"
										class="gap-1 text-error hover:bg-error-subtle"
										@click="openRejectModal(message._id)"
									>
										<Icon name="lucide:x" class="w-3 h-3" />
										{{ t('dashboard.inbox.detail.reject') }}
									</UiButton>
								</div>
								<!-- Soft-hold reason: a teammate is replying; releases on its own. -->
								<p
									v-if="isHeld && holdReason"
									class="mt-2 inline-flex items-center gap-1.5 text-2xs text-text-tertiary"
									data-testid="thread-held-reason"
									role="status"
								>
									<Icon
										name="lucide:pencil-line"
										class="w-3 h-3 text-warning shrink-0"
										aria-hidden="true"
									/>
									<span>{{ holdReason }}</span>
								</p>
							</template>
						</div>
					</div>

					<!-- Empty messages -->
					<div v-if="messages.length === 0" class="card text-center py-8">
						<p class="text-text-tertiary">{{ t('dashboard.inbox.detail.noMessages') }}</p>
					</div>
				</div>

				<!-- Sidebar -->
				<div class="space-y-6">
					<!-- Contact Card -->
					<div v-if="contact" class="card">
						<h2 class="text-lg font-medium text-text-primary mb-4">
							{{ t('dashboard.inbox.detail.contact') }}
						</h2>
						<div class="space-y-3">
							<div class="flex items-center gap-3">
								<UiIconBox icon="lucide:user" size="sm" variant="surface" rounded="full" />
								<div>
									<p class="text-text-primary text-sm font-medium">
										{{
											contact.firstName || contact.lastName
												? `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim()
												: contact.email
										}}
									</p>
									<p class="text-xs text-text-tertiary">{{ contact.email }}</p>
								</div>
							</div>
							<NuxtLink
								:to="`/dashboard/audience/contacts/${contact._id}`"
								class="text-sm text-brand hover:underline"
							>
								{{ t('dashboard.inbox.detail.viewContactProfile') }}
							</NuxtLink>
						</div>
					</div>

					<!-- Thread Details -->
					<div class="card">
						<h2 class="text-lg font-medium text-text-primary mb-4">
							{{ t('dashboard.inbox.detail.details') }}
						</h2>
						<div class="space-y-3">
							<div>
								<p class="text-xs text-text-tertiary mb-1">{{ t('common.status') }}</p>
								<InboxStatusChip
									:status="thread.status"
									:latest-draft-status="thread.latestDraftStatus"
									:snoozed-until="thread.snoozedUntil"
									:snooze-returned-at="thread.snoozeReturnedAt"
								/>
							</div>
							<div>
								<p class="text-xs text-text-tertiary">{{ t('dashboard.inbox.detail.messages') }}</p>
								<p class="text-text-primary">{{ thread.messageCount ?? 0 }}</p>
							</div>
							<div>
								<p class="text-xs text-text-tertiary mb-1">
									{{ t('dashboard.inbox.detail.assignedTo') }}
								</p>
								<InboxAssignPopover
									:members="assignMembers"
									:current-user-id="user?.id ?? null"
									:assigned-to="thread.assignedTo ?? null"
									position="left"
									@assign="onAssign"
								>
									<template #trigger>
										<button
											type="button"
											class="w-full flex items-center gap-2 text-sm border border-border-subtle rounded-lg px-2 py-1.5 bg-bg-surface text-text-primary hover:bg-(--surface-1-hover) transition-colors duration-(--motion-fast) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
											:aria-label="t('dashboard.inbox.detail.assignToTeammateAria')"
										>
											<UiAvatar
												v-if="thread.assignedTo"
												:name="assignedMemberName ?? undefined"
												deterministic-color
												size="sm"
											/>
											<Icon v-else name="lucide:user-plus" class="w-4 h-4 text-text-tertiary" />
											<span class="flex-1 truncate text-left">
												{{ assignedMemberName ?? t('dashboard.inbox.detail.unassigned') }}
											</span>
											<Icon
												name="lucide:chevron-down"
												class="w-3.5 h-3.5 text-text-tertiary shrink-0"
											/>
										</button>
									</template>
								</InboxAssignPopover>
							</div>
							<div v-if="thread.lastMessageAt">
								<p class="text-xs text-text-tertiary">
									{{ t('dashboard.inbox.detail.lastMessage') }}
								</p>
								<p class="text-text-primary text-sm">{{ formatTimestamp(thread.lastMessageAt) }}</p>
							</div>
						</div>
					</div>

					<!-- Cross-channel unified timeline for this thread -->
					<InboxThreadChannelTimeline :thread-id="threadId" />
				</div>
			</div>
		</template>

		<!-- Reject Modal -->
		<UiModal
			:open="showRejectModal"
			:title="t('dashboard.inbox.detail.rejectDraft')"
			:closable="!isRejecting"
			:persistent="isRejecting"
			@update:open="(v: boolean) => !v && (showRejectModal = false)"
		>
			<p class="text-sm text-text-secondary mb-4">
				{{ t('dashboard.inbox.detail.rejectModalBody') }}
			</p>
			<textarea
				v-model="rejectReason"
				rows="3"
				class="input w-full resize-y"
				:placeholder="t('dashboard.inbox.detail.rejectReasonPlaceholder')"
				:disabled="isRejecting"
			/>

			<template #footer>
				<UiButton variant="secondary" :disabled="isRejecting" @click="showRejectModal = false">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton variant="danger" :loading="isRejecting" @click="onReject">
					{{
						isRejecting
							? t('dashboard.inbox.detail.rejecting')
							: t('dashboard.inbox.detail.rejectDraft')
					}}
				</UiButton>
			</template>
		</UiModal>
	</div>
</template>
