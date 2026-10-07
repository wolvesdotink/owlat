<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { useOrganization } from '~/composables/useOrganization';
import { teamThreadPreview } from '~/utils/teamThreadPreviews';
import { formatRelativeTime } from '~/utils/formatters';
import { otherWaitingDrafts, pickReplyTarget, replySubject } from '~/utils/teamThreadReply';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import { countMentionsOf, type ReplyEntry } from '~/utils/teamStream';
import { useTeamThread } from '~/composables/team/useTeamThread';
import { useAnswerModeNav } from '~/composables/useAnswerMode';
import { useTeamKeptReply } from '~/composables/useTeamKeptReply';
import { inboxRetryToast } from '~/utils/inboxRetry';

const { t, locale } = useI18n();

useHead({ title: () => t('dashboard.inbox.detail.pageTitle') });

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
	else if (isAdmin.value) composer.value?.focus('note');
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
const replySenderLabel = computed(() => {
	if (contact.value) {
		const name = `${contact.value.firstName ?? ''} ${contact.value.lastName ?? ''}`.trim();
		return name || contact.value.email || '';
	}
	return replyTarget.value?.from ?? '';
});
// ── The stream: emails, replies, internal notes and what happened, in one order ──
const team = useTeamThread({
	target: () => ({ kind: 'team', id: threadId.value }),
	enabled: () => isAdmin.value,
	onReply: () => openReply(),
});
const messageById = computed(() => new Map(messages.value.map((m) => [m._id as string, m])));
// A note mentioning me lands while I have the thread open: I have seen it, so
// the Mentions badge must not keep counting it until the next visit.
watch(
	() => countMentionsOf(team.stream.entries.value, user.value?.id),
	(count, before) => {
		if (count > (before ?? 0)) markSeen();
	}
);
watch(
	() => team.stream.entries.value.at(-1)?.key,
	(key) => key && team.stream.markSeen()
);
const composer = ref<{ focus: (mode?: 'note' | 'reply') => void } | null>(null);
// What is typed in "Reply to …" waits for Answer mode, which picks it up.
const replyDraft = computed({
	get: () => keptReply.get(threadId.value)?.body ?? '',
	set: (body: string) =>
		keptReply.set(threadId.value, {
			body,
			subject: replyTarget.value ? replySubject(replyTarget.value) : '',
		}),
});

// "Compose email" (top bar, palette, shortcut) on a thread answers the thread.
watch(useThreadReplyRequest(), () => openReply());

const undoingFollowUpId = ref<Id<'inboxFollowUps'> | null>(null);
async function undoFollowUp(entry: ReplyEntry) {
	const followUpId = entry.followUpId;
	if (!followUpId || undoingFollowUpId.value) return;
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
				<!-- The thread as one stream; the open actions pinned above it. -->
				<div class="lg:col-span-2 xl:col-span-1 space-y-4" data-testid="team-thread-main">
					<TeamPinnedItems v-if="isAdmin" :team="team" />
					<TeamThreadStream
						:entries="team.stream.entries.value"
						:has-earlier="team.stream.hasEarlier.value"
						:loading-earlier="team.stream.isLoadingEarlier.value"
						:seen-position="team.stream.seenPosition.value"
						:viewer-id="team.viewerId.value"
						:member-name="team.memberName"
						:can-edit-note="team.canEditNote"
						:can-delete-note="(entry) => isAdmin || entry.authorId === user?.id"
						:can-react="isAdmin"
						:save-note="team.editNote"
						:candidates-for="team.candidatesFor"
						:undoing-follow-up-id="undoingFollowUpId"
						@load-earlier="team.stream.loadEarlier"
						@react-note="team.reactNote"
						@delete-note="team.deleteNote"
						@undo-follow-up="undoFollowUp"
					>
						<template #email="{ entry }">
							<InboxStreamEmail
								v-if="messageById.get(entry.source.id)"
								:message="messageById.get(entry.source.id)!"
								:contact="contact"
								:is-admin="isAdmin"
								:has-waiting-draft="waitingDraftIds.has(entry.source.id as Id<'inboundMessages'>)"
								:retrying="isRetrying"
								:undoing-auto-send="isUndoingAutoSend"
								@answer="openReply(entry.source.id as Id<'inboundMessages'>)"
								@reject="openRejectModal(entry.source.id as Id<'inboundMessages'>)"
								@retry="onRetry(entry.source.id as Id<'inboundMessages'>)"
								@cancel-auto-send="cancelAutoSend(entry.source.id as Id<'inboundMessages'>)"
							/>
						</template>
					</TeamThreadStream>

					<UiEmptyState
						v-if="messages.length === 0"
						icon="lucide:mail"
						:title="t('dashboard.inbox.detail.noMessages')"
					/>

					<!-- Internal note or Reply to the customer (Answer mode), each with its own draft. -->
					<TeamNoteComposer
						v-if="isAdmin"
						ref="composer"
						v-model:reply-draft="replyDraft"
						:draft-key="`team:${threadId}`"
						:reply-name="replyTarget ? replySenderLabel : null"
						:items="team.items.value"
						:candidates-for="team.candidatesFor"
						:submit-note="team.postNote"
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

					<!-- SMS / WhatsApp on this thread, answerable here; nothing for email-only threads. -->
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
