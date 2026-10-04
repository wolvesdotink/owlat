<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { useOrganization } from '~/composables/useOrganization';
import { teamThreadPreview } from '~/utils/teamThreadPreviews';
import { capitalize, formatRelativeTime } from '~/utils/formatters';
import {
	classificationSummary,
	latestClassification,
	otherWaitingDrafts,
	pickReplyTarget,
} from '~/utils/teamThreadReply';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import { countNotesMentioning, interleaveNotes } from '~/utils/threadNotes';
import { useAnswerModeNav } from '~/composables/useAnswerMode';
import { useTeamKeptReply } from '~/composables/useTeamKeptReply';
import { inboxRetryToast } from '~/utils/inboxRetry';

const { t, te, locale } = useI18n();

useHead({ title: () => t('dashboard.inbox.detail.pageTitle') });

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
// The Team Inbox row this thread was opened from, if the list loaded it.
const threadPreview = computed(() => teamThreadPreview(threadId.value));

const {
	thread,
	messages,
	contact,
	followUps,
	threadLoading,
	threadError,
	refetchThread,
	handleReject,
	handleRetry,
	cancelFollowUp,
	handleStatusChange,
	handleSnooze,
	handleUnsnooze,
	handleAssign,
} = useThreadDetail(threadId);
const { isEnabled: isFeatureEnabled } = useFeatureFlag();
const answerNav = useAnswerModeNav();
const keptReply = useTeamKeptReply();

// Times read relative ("2 hours ago"), with the exact moment in the reader's
// locale on hover — the same as everywhere else in the app.
function absoluteTime(timestamp: number): string {
	return new Date(timestamp).toLocaleString(locale.value, {
		dateStyle: 'medium',
		timeStyle: 'short',
	});
}

// Breadcrumb: this is a Team inbox thread, not the generic "Inbox" the path
// fallback derives from the URL segment.
const { setDynamicBreadcrumbs, clearDynamicBreadcrumbs } = useBreadcrumbs();
setDynamicBreadcrumbs([
	{ label: 'shared.breadcrumbRoutes.sections.teamInbox', href: '/dashboard/inbox' },
	{ label: 'dashboard.inbox.detail.breadcrumb' },
]);
onBeforeUnmount(clearDynamicBreadcrumbs);

// The header's one-line classification ("Billing · urgent"), from the newest
// message the agent classified. The detail sits behind the admin disclosure.
const classificationLine = computed(() => {
	const summary = classificationSummary(latestClassification(messages.value));
	if (!summary) return null;
	const parts = [capitalize(classificationLabel('categories', summary.category))];
	if (summary.priority) parts.push(classificationLabel('priorities', summary.priority));
	return parts.join(' · ');
});

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
// `r` opens the reply in Answer mode, as the shortcut sheet promises; `n`
// opens an internal note under the thread.
function onThreadKeydown(event: KeyboardEvent) {
	const key = event.key.toLowerCase();
	if (key !== 'i' && key !== 'r' && key !== 'n') return;
	if (event.metaKey || event.ctrlKey || event.altKey) return;
	// Never hijack typing in an input / textarea / contenteditable.
	if (isEditableTarget(event.target)) return;
	event.preventDefault();
	if (key === 'i') assignToMe();
	else if (key === 'r') openReply();
	else if (isAdmin.value) composeBar.value?.openNote();
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
	// The route guard is `auth`, not `admin`, but the shared inbox is owner/admin
	// only (ADR-0040) — so a member can land here, and calling the mutation would
	// toast a `forbidden` at them over a badge they cannot see anyway. Same guard
	// the other admin writes on this page open with.
	if (!isAdmin.value) return;
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

// Live thread presence — heartbeat while this thread is open (the reply is
// written in Answer mode, which reports "replying" itself). `others` excludes
// the current user; resolve each to a display name/avatar via the
// already-fetched org members.
const { others: presenceOthers } = useThreadPresence(threadId, { replying: ref(false) });
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

// Actions state
const isRejecting = ref(false);
const isRetrying = ref(false);
const rejectReason = ref('');
const showRejectModal = ref(false);
const actionMessageId = ref<Id<'inboundMessages'> | null>(null);
const { run: undoAutoSend, isLoading: isUndoingAutoSend } = useBackendOperation(
	api.inbox.mutations.undoAutoSend,
	{ label: () => t('dashboard.inbox.detail.undoAutoSendOperation') }
);

async function cancelAutoSend(messageId: Id<'inboundMessages'>) {
	if (!isAdmin.value) return;
	const result = await undoAutoSend({ inboundMessageId: messageId });
	if (result.ok && result.result.cancelled)
		showToast(t('dashboard.inbox.detail.autoSendCancelledToast'));
}

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

// ── Reply ──
// Every reply is written in Answer mode (`/dashboard/answer/t/<threadId>`); this
// page keeps assignment, status and the discussion. The reply answers the
// newest message still waiting; a note on an older message that also holds a
// waiting draft opens Answer mode on that one instead.
const replyTarget = computed(() => pickReplyTarget(messages.value));
const waitingDraftIds = computed(
	() => new Set(otherWaitingDrafts(messages.value, replyTarget.value).map((m) => m._id))
);
function openReply(messageId?: Id<'inboundMessages'>) {
	void answerNav.openTeam(threadId.value, { messageId: messageId ?? null });
}
function answerMessage(messageId: Id<'inboundMessages'>) {
	openReply(messageId);
}
const replySenderLabel = computed(() => {
	if (contact.value) {
		const name = `${contact.value.firstName ?? ''} ${contact.value.lastName ?? ''}`.trim();
		return name || contact.value.email || '';
	}
	return replyTarget.value?.from ?? '';
});
// A message header names its sender when that sender is the thread's contact;
// the address stays beside it, muted. Anyone else keeps the bare address.
function senderName(message: { from: string; contactId?: string }): string | null {
	const c = contact.value;
	if (!c) return null;
	const isContact =
		message.contactId === c._id || message.from.toLowerCase() === (c.email ?? '').toLowerCase();
	if (!isContact) return null;
	return `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || null;
}
// The agent's working is only worth a disclosure when there is some: a
// classification, a recorded decision, or a pipeline stop (failed/quarantined).
function hasAgentInsight(message: {
	classification?: unknown;
	agentDecision?: unknown;
	processingStatus: string;
}): boolean {
	return Boolean(
		message.classification ||
		message.agentDecision ||
		message.processingStatus === 'failed' ||
		message.processingStatus === 'quarantined'
	);
}
// ── Internal notes: between the messages by time, written under the thread ──
const threadNotes = useThreadNotes(threadId, { enabled: () => isAdmin.value });
const noteSlots = computed(() => interleaveNotes(messages.value, threadNotes.notes.value));
// A note mentioning me lands while I have the thread open: I have seen it, so
// the Mentions badge must not keep counting it until the next visit.
watch(
	() => countNotesMentioning(threadNotes.notes.value, user.value?.id),
	(count, before) => {
		if (count > (before ?? 0)) markSeen();
	}
);
const composeBar = ref<{ openNote: () => void } | null>(null);

// "Compose email" (top bar, palette, shortcut) on a thread answers the thread.
watch(useThreadReplyRequest(), () => openReply());

// ── What the team sent ──
// The reply that answered each message, and the follow-ups written after it,
// shown under the message they answer.
function memberName(userId: string): string {
	const m = members.value.find((x) => x.userId === userId);
	return m ? m.user.name || m.user.email : t('dashboard.inbox.detail.outbound.yourTeam');
}
function sentReplyAuthor(message: NonNullable<typeof messages.value>[number]): string {
	return message.approvalSource === 'auto'
		? t('dashboard.inbox.detail.outbound.agent')
		: t('dashboard.inbox.detail.outbound.yourTeam');
}
function followUpsFor(messageId: Id<'inboundMessages'>) {
	return followUps.value.filter((f) => f.inReplyToMessageId === messageId);
}
const undoingFollowUpId = ref<Id<'inboxFollowUps'> | null>(null);
async function undoFollowUp(followUpId: Id<'inboxFollowUps'>) {
	if (undoingFollowUpId.value) return;
	undoingFollowUpId.value = followUpId;
	try {
		const result = await cancelFollowUp(followUpId);
		if (!result.ok || !result.result.cancelled) return;
		// Hand the text back so nothing typed is lost: it waits in the reply,
		// which opens in Answer mode.
		keptReply.set(threadId.value, { body: result.result.body, subject: result.result.subject });
		showToast(t('dashboard.inbox.detail.followUpUndoneToast'));
		openReply();
	} finally {
		undoingFollowUpId.value = null;
	}
}

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
		if (result.ok) showToast(t(inboxRetryToast(result.result.retried)));
	} finally {
		isRetrying.value = false;
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

const currentStatus = computed<(typeof statusOptions)[number]>(() => {
	const status = thread.value?.status;
	// Legacy `closed` (and anything unexpected) reads as Resolved.
	return status === 'open' || status === 'waiting' ? status : 'resolved';
});

// Chat integration: surface existing chat channels that already discuss this
// thread, and offer to spin up a new one. Only active when the chat flag is
// enabled — the query throws FEATURE_DISABLED otherwise.
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
	<div class="mx-auto w-full max-w-page p-6 lg:p-8">
		<!-- Back Navigation -->
		<NuxtLink
			to="/dashboard/inbox"
			class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors mb-6"
		>
			<Icon name="lucide:arrow-left" class="w-4 h-4" />
			{{ t('dashboard.inbox.detail.backToInbox') }}
		</NuxtLink>

		<!-- A failed read is not a missing thread (#721). -->
		<UiQueryBoundary v-if="threadError" :error="threadError" @retry="refetchThread" />

		<!-- Loading: the page's own shape, headed by the list row when we have it. -->
		<InboxThreadDetailSkeleton v-else-if="threadLoading && !thread" :preview="threadPreview" />

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
			<!-- Header. Wraps: next to four action buttons the subject was squeezed
			     into a narrow column on a tablet; below 24rem it gets its own line. -->
			<div class="mb-6 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
				<div class="min-w-0 flex-[1_1_24rem]">
					<!-- The subject, once. Messages below don't repeat it. -->
					<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary break-words">
						{{ thread.subject || t('dashboard.inbox.detail.noSubject') }}
					</h1>
					<p
						class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-tertiary"
						data-testid="thread-meta"
					>
						<span v-if="contact" class="text-text-secondary">{{ contact.email }}</span>
						<span v-if="contact" aria-hidden="true">·</span>
						<span>
							{{
								t(
									'dashboard.inbox.detail.messageCount',
									{ count: thread.messageCount ?? 0 },
									thread.messageCount ?? 0
								)
							}}
						</span>
						<!-- What the agent made of it, in one line. Detail is admin-only,
						     behind "Why did the agent do this?" on the message. -->
						<template v-if="classificationLine">
							<span aria-hidden="true">·</span>
							<span data-testid="thread-classification">{{ classificationLine }}</span>
						</template>
						<template v-if="isSnoozed && thread.snoozedUntil">
							<span aria-hidden="true">·</span>
							<span class="inline-flex items-center gap-1">
								<Icon name="lucide:alarm-clock" class="w-3.5 h-3.5" aria-hidden="true" />
								<time
									:datetime="new Date(thread.snoozedUntil).toISOString()"
									:title="absoluteTime(thread.snoozedUntil)"
								>
									{{
										t('dashboard.inbox.detail.snoozedUntil', {
											time: formatRelativeTime(thread.snoozedUntil),
										})
									}}
								</time>
							</span>
						</template>
					</p>
					<!-- Who else is here — pulsing viewer ring + "is replying" banner -->
					<InboxThreadPresence :people="presencePeople" class="mt-3" />
				</div>

				<InboxThreadHeaderActions
					:is-admin="isAdmin"
					:chat-enabled="chatEnabled"
					:discussion-channels="discussionChannels"
					:members="assignMembers"
					:current-user-id="user?.id ?? null"
					:assigned-to="thread.assignedTo ?? null"
					:assigned-member-name="assignedMemberName"
					:is-snoozed="isSnoozed"
					:current-status="currentStatus"
					@reply="openReply()"
					@assign="onAssign"
					@new-channel="showNewChannel = true"
					@snooze="showSnoozeDialog = true"
					@unsnooze="onUnsnooze"
					@status="handleStatusChange"
				/>
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

			<!-- From xl the side column keeps a fixed width instead of a third of an
			     ever wider page. -->
			<div class="grid grid-cols-1 lg:grid-cols-3 xl:grid-cols-[minmax(0,1fr)_20rem] gap-6">
				<!-- Messages Timeline -->
				<div class="lg:col-span-2 xl:col-span-1 space-y-4">
					<InboxNoteList
						v-if="noteSlots.leading.length > 0"
						:items="noteSlots.leading"
						:notes="threadNotes"
						:is-admin="isAdmin"
					/>
					<template v-for="message in messages" :key="message._id">
						<div class="card">
							<!-- Message Header -->
							<div class="flex items-center gap-3 mb-4">
								<UiIconBox icon="lucide:mail" size="sm" variant="surface" rounded="full" />
								<div class="min-w-0">
									<p class="truncate text-sm">
										<template v-if="senderName(message)">
											<span class="font-medium text-text-primary">{{ senderName(message) }}</span>
											<span class="ml-1.5 text-xs text-text-tertiary">{{ message.from }}</span>
										</template>
										<span v-else class="font-medium text-text-primary">{{ message.from }}</span>
									</p>
									<time
										class="text-xs text-text-tertiary"
										:datetime="new Date(message._creationTime).toISOString()"
										:title="absoluteTime(message._creationTime)"
									>
										{{ formatRelativeTime(message._creationTime) }}
									</time>
								</div>
							</div>

							<!-- The mirror of the Postbox reader's strip (idea 31): this
						     message also sits in someone's personal mailbox, and it may
						     already have been answered there. Read-only; renders nothing
						     unless the viewer is permitted on both surfaces. -->
							<InboxCrossSurfaceStrip :inbound-message-id="message._id" class="mb-3" />

							<!-- Message Body. A text part too large for its row is fetched
						     from storage; the component shows its excerpt until then. -->
							<InboxMessageBody :message="message" />

							<!-- Attachments. getThread returns the row unprojected, so the
						     list needs no extra query; the component owns the download. -->
							<InboxMessageAttachments :message="message" />

							<!-- Another message in this thread also has a draft waiting: say so,
						     and let the person answer or reject it here, in order. -->
							<div
								v-if="isAdmin && waitingDraftIds.has(message._id)"
								class="mt-4 flex flex-wrap items-center gap-2 rounded-lg bg-warning/10 p-3"
								data-testid="thread-waiting-draft"
							>
								<p class="flex-1 text-xs text-text-secondary">
									{{ t('dashboard.inbox.detail.waitingDraft.notice') }}
								</p>
								<UiButton variant="secondary" size="sm" @click="answerMessage(message._id)">
									<Icon name="lucide:reply" class="w-3.5 h-3.5" />
									{{ t('dashboard.inbox.detail.waitingDraft.answer') }}
								</UiButton>
								<UiButton variant="ghost" size="sm" @click="openRejectModal(message._id)">
									{{ t('dashboard.inbox.detail.composer.rejectDraft') }}
								</UiButton>
							</div>

							<!-- Failure reason + a Retry that says what it does (terminal 'failed' state) -->
							<InboxFailedNotice
								v-if="message.processingStatus === 'failed'"
								:message="message"
								:retrying="isRetrying"
								@retry="onRetry(message._id)"
							/>

							<!-- The agent's questions are answered where the reply is written. -->
							<div
								v-if="
									isAdmin &&
									message.processingStatus === 'awaiting_clarification' &&
									message.pendingClarification
								"
								class="mt-4 flex flex-wrap items-center gap-2 rounded-lg border-l-2 border-l-brand/60 surface-2 p-3"
								data-testid="thread-clarification-pointer"
							>
								<p class="flex-1 text-sm text-text-secondary">
									{{ t('dashboard.inbox.detail.agentNeedsInput') }}
								</p>
								<UiButton size="sm" @click="openReply(message._id)">
									<Icon name="lucide:message-circle-question" class="w-3.5 h-3.5" />
									{{ t('dashboard.inbox.detail.answerInReply') }}
								</UiButton>
							</div>

							<InboxAutoSendCountdown
								v-if="isAdmin && message.pendingAutoSend"
								:send-at="message.pendingAutoSend.sendAt"
								:busy="isUndoingAutoSend"
								@cancel="cancelAutoSend(message._id)"
							/>

							<!-- The agent's working, for admins, behind one disclosure. -->
							<InboxAgentInsight
								v-if="isAdmin && hasAgentInsight(message)"
								:inbound-message-id="message._id"
								:classification="message.classification ?? null"
								:decision-reason="message.agentDecision?.reason ?? null"
							/>
						</div>

						<!-- What the team sent: the reply that answered it, then any follow-ups. -->
						<InboxThreadOutbound
							v-if="message.processingStatus === 'sent' && message.draftResponse"
							:author-label="sentReplyAuthor(message)"
							:body="message.draftResponse"
							:at="message.processedAt ?? message._creationTime"
							status="sent"
						/>
						<InboxThreadOutbound
							v-for="followUp in followUpsFor(message._id)"
							:key="followUp._id"
							:author-label="memberName(followUp.createdBy)"
							:body="followUp.body"
							:at="followUp.sentAt ?? followUp.createdAt"
							:status="followUp.status"
							:send-at="followUp.sendAt"
							:error-message="followUp.errorMessage ?? null"
							:undoing="undoingFollowUpId === followUp._id"
							@undo="undoFollowUp(followUp._id)"
						/>
						<!-- The team's internal notes written after this message. -->
						<InboxNoteList
							v-if="noteSlots.after.has(message._id)"
							:items="noteSlots.after.get(message._id) ?? []"
							:notes="threadNotes"
							:is-admin="isAdmin"
						/>
					</template>

					<!-- Empty messages -->
					<UiEmptyState
						v-if="messages.length === 0"
						icon="lucide:mail"
						:title="t('dashboard.inbox.detail.noMessages')"
					/>

					<!-- Every reply is written in Answer mode; this is the way in. Beside
					     it, an internal note only the team sees. -->
					<InboxThreadComposeBar
						v-if="isAdmin"
						ref="composeBar"
						:notes="threadNotes"
						:reply-label="
							replyTarget
								? t('dashboard.inbox.detail.composer.replyTo', { name: replySenderLabel })
								: null
						"
						@reply="openReply()"
					/>
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

					<!-- Thread Details. Status is changed in the header (its one
					     control) and not repeated here. -->
					<div class="card">
						<h2 class="text-lg font-medium text-text-primary mb-4">
							{{ t('dashboard.inbox.detail.details') }}
						</h2>
						<div class="space-y-3">
							<div>
								<p class="text-xs text-text-tertiary">{{ t('dashboard.inbox.detail.messages') }}</p>
								<p class="text-text-primary">{{ thread.messageCount ?? 0 }}</p>
							</div>
							<!-- Assignment READS here and is CHANGED in the header (and on row
							     hover in the list). A second assign popover here would render
							     the same verb twice on one screen; the details card is a list
							     of facts about the thread, and this is one of them. -->
							<div>
								<p class="text-xs text-text-tertiary mb-1">
									{{ t('dashboard.inbox.detail.assignedTo') }}
								</p>
								<div class="flex items-center gap-2 text-sm text-text-primary">
									<UiAvatar
										v-if="thread.assignedTo"
										:name="assignedMemberName ?? undefined"
										deterministic-color
										size="sm"
									/>
									<Icon v-else name="lucide:user-round" class="w-4 h-4 text-text-tertiary" />
									<span class="truncate">
										{{ assignedMemberName ?? t('dashboard.inbox.detail.unassigned') }}
									</span>
								</div>
							</div>
							<div v-if="thread.lastMessageAt">
								<p class="text-xs text-text-tertiary">
									{{ t('dashboard.inbox.detail.lastMessage') }}
								</p>
								<time
									class="text-text-primary text-sm"
									:datetime="new Date(thread.lastMessageAt).toISOString()"
									:title="absoluteTime(thread.lastMessageAt)"
								>
									{{ formatRelativeTime(thread.lastMessageAt) }}
								</time>
							</div>
						</div>
					</div>

					<!-- Other channels on this thread — renders nothing until one speaks. -->
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
