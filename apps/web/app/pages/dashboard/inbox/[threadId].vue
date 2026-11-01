<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { teamThreadPreview } from '~/utils/teamThreadPreviews';
import {
	isChannelMessage,
	otherWaitingDrafts,
	pickReplyTarget,
	replySubject,
} from '~/utils/teamThreadReply';
import { vReplyDrop } from '~/composables/useReplyFileDrop';
import type { ReplyDropTarget } from '~/utils/replyFileDrop';
import { countMentionsOf, type ReplyEntry } from '~/utils/teamStream';
import { useTeamThread } from '~/composables/team/useTeamThread';
import { useZenMode } from '~/composables/useZenMode';
import { useAnswerModeNav } from '~/composables/useAnswerMode';
import { useTeamKeptReply } from '~/composables/useTeamKeptReply';
import { teamNoteDraftKey } from '~/composables/useComposerDrafts';
import {
	TEAM_THREAD_PRIORITY_KEYS,
	type TeamThreadPriority,
	teamThreadPriorityOf,
} from '~/utils/teamThreadPriority';
import { useTeamThreadCommandSurface } from '~/composables/team/useTeamThreadCommandSurface';
import { useTeamThreadPeople } from '~/composables/team/useTeamThreadPeople';
import { useTeamThreadAutoClose } from '~/composables/team/useTeamThreadAutoClose';
import { useTeamThreadDiscussionChannels } from '~/composables/team/useTeamThreadDiscussionChannels';
import { useTeamThreadSnooze } from '~/composables/team/useTeamThreadSnooze';
import { useTeamThreadDraftActions } from '~/composables/team/useTeamThreadDraftActions';
import { useRecordPaletteObjectOpen } from '~/composables/useCommandPaletteObjectRecents';
import { isAutoClosed } from '~/utils/inboxAutoClose';
import { useConversationLink } from '~/composables/useConversationLink';
import { ArrowLeftIcon, CircleWarningIcon, MailIcon } from '@coolicons/vue';

const { t } = useI18n();
// Zen: the conversation and the reply only; the side cards wait outside.
const { isZen } = useZenMode();

useHead({ title: () => t('dashboard.inbox.detail.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'inbox',
});

const threadId = useRouteId<'conversationThreads'>('threadId');
// The Team Inbox row this thread was opened from, if the list loaded it.
const threadPreview = computed(() => teamThreadPreview(threadId.value));

const detail = useThreadDetail(threadId);
const {
	thread,
	messages,
	contact,
	threadLoading,
	threadError,
	refetchThread,
	handleReject,
	cancelFollowUp,
	handleStatusChange,
	handleAssign,
	handleSetPriority,
} = detail;
const answerNav = useAnswerModeNav();
const keptReply = useTeamKeptReply();

// Breadcrumb: this is a Team inbox thread, not the generic "Inbox" the path
// fallback derives from the URL segment.
const { setDynamicBreadcrumbs, clearDynamicBreadcrumbs } = useBreadcrumbs();
setDynamicBreadcrumbs([
	{ label: 'shared.breadcrumbRoutes.sections.teamInbox', href: '/dashboard/inbox' },
	{ label: 'dashboard.inbox.detail.breadcrumb' },
]);
onBeforeUnmount(clearDynamicBreadcrumbs);

// Snooze picker — reuses the Postbox snooze presets (PostboxSnoozeDialog).
const { showSnoozeDialog, isSnoozed, onSnoozeConfirm, onSnoozeUntilReply, onUnsnooze } =
	useTeamThreadSnooze({ thread, detail });

// The org members the assignee picker offers, the assignee's name, and who
// else has the thread open.
const { user } = useAuth();
const { isAdmin } = usePermissions();
const { assignMembers, assignedMemberName, presencePeople } = useTeamThreadPeople({
	threadId,
	assignedTo: () => thread.value?.assignedTo,
});
const onAssign = (assignedTo: string | undefined) => {
	void handleAssign(assignedTo);
};
// `i` anywhere on the thread claims it for me — mirrors the list shortcut.
const assignToMe = () => {
	const me = user.value?.id;
	if (me) void handleAssign(me);
};
// The thread's keys (`i` assigns it to me, `r` opens the reply in Answer mode,
// `n` an internal note) live in the `inbox` scope, so they take precedence over
// the app-wide `n` here and follow the person's remaps.
useShortcutScope('inbox');
const { registerShortcut } = useKeyboardShortcuts();
registerShortcut({ id: 'inbox.assignToMe', handler: assignToMe });
registerShortcut({ id: 'inbox.reply', handler: () => openReply() });
registerShortcut({
	id: 'inbox.note',
	handler: () => composer.value?.focus('note'),
	when: () => isAdmin.value,
});

// Mark the thread seen for THIS user (per-user unread, mirroring chat's
// lastReadAt) on open and whenever we navigate to another thread. Best-effort:
// a failed mark just leaves the row bold until the next open.
const { run: markThreadSeen } = useBackendOperation(api.inbox.reads.markThreadSeen, {
	label: () => t('dashboard.inbox.detail.markSeenOperation'),
});
const markSeen = () => {
	// The route guard is `auth`, not `admin`, but the shared inbox is owner/admin
	// only — so a member can land here, and calling the mutation would
	// toast a `forbidden` at them over a badge they cannot see anyway. Same guard
	// the other admin writes on this page open with.
	if (!isAdmin.value) return;
	void markThreadSeen({ threadId: threadId.value });
};
onMounted(markSeen);
watch(threadId, markSeen);
// Actions state
const showRejectModal = ref(false);
const actionMessageId = ref<Id<'inboundMessages'> | null>(null);
const { isRetrying, onRetry, isUndoingAutoSend, cancelAutoSend } = useTeamThreadDraftActions({
	isAdmin,
	detail,
});

// Use the shared global toast. The underlying actions go through
// useBackendOperation, which already toasts any categorized failure — so we
// only emit the success toast here, and only when the operation truly
// succeeded (run resolves to `ok: false` on failure, never throws).
const { showToast } = useToast();

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
// Files dropped on the thread reply to it with them, as Reply does. Only for a
// viewer who may reply, and only by email: a channel reply carries no files.
const replyDrop = computed<ReplyDropTarget | null>(() =>
	isAdmin.value && replyTarget.value && !isChannelMessage(replyTarget.value)
		? { kind: 'team', id: threadId.value, recipient: replySenderLabel.value }
		: null
);
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

// Priority: shown beside the message count when it is not normal, set from ⌘K.
const priority = computed(() => teamThreadPriorityOf(thread.value));
async function onSetPriority(next: TeamThreadPriority) {
	const result = await handleSetPriority(next);
	if (result.ok && result.result.changed) {
		showToast(
			t('dashboard.inbox.detail.priorityToast', { priority: t(TEAM_THREAD_PRIORITY_KEYS[next]) })
		);
	}
}

// "Copy link" / "Share in chat…" (header ⋯ and palette). The link opens for
// whoever can read the Team Inbox; it grants nothing by itself.
const { copyConversationLink } = useConversationLink();
const copyThreadLink = () => void copyConversationLink({ kind: 'team', threadId: threadId.value });
const showShareInChat = ref(false);

// ⌘K on this thread: every verb the page has (`~/lib/commandPaletteThreadSurfaces`),
// and the thread joins the palette's "Jump back" list.
useTeamThreadCommandSurface({
	subject: () => thread.value?.subject ?? '',
	canAct: () => isAdmin.value && !!thread.value,
	isMine: () => !!user.value?.id && thread.value?.assignedTo === user.value.id,
	isResolved: () => currentStatus.value === 'resolved',
	isSnoozed: () => isSnoozed.value,
	priority: () => priority.value,
	assignedTo: () => thread.value?.assignedTo ?? null,
	members: () => assignMembers.value,
	onReply: () => openReply(),
	onAssign,
	onClaim: assignToMe,
	onStatus: (status) => void handleStatusChange(status),
	onSnooze: (until) => void onSnoozeConfirm(until),
	onSnoozeUntilReply: (cap) => void onSnoozeUntilReply(cap),
	onPickSnooze: () => (showSnoozeDialog.value = true),
	onUnsnooze: () => void onUnsnooze(),
	// After the palette has closed and handed focus back.
	onAddNote: () => window.setTimeout(() => composer.value?.focus('note'), 0),
	onSetPriority: (next) => void onSetPriority(next),
	onCopyLink: copyThreadLink,
	canShareInChat: () => chatEnabled.value,
	onShareInChat: () => (showShareInChat.value = true),
});
useRecordPaletteObjectOpen(() =>
	thread.value
		? {
				kind: 'teamThread',
				id: threadId.value,
				title: thread.value.subject || t('dashboard.inbox.detail.noSubject'),
				href: `/dashboard/inbox/${threadId.value}`,
			}
		: null
);

const undoingFollowUpId = ref<Id<'inboxFollowUps'> | null>(null);
async function undoFollowUp(entry: ReplyEntry) {
	const followUpId = entry.followUpId;
	if (!followUpId || undoingFollowUpId.value) return;
	undoingFollowUpId.value = followUpId;
	const handBack = keptReply.pin(threadId.value);
	try {
		const result = await cancelFollowUp(followUpId);
		if (!result.ok || !result.result.cancelled) return;
		// Hand the text back so nothing typed is lost: it waits in the reply,
		// which opens in Answer mode.
		const { body, subject } = result.result;
		handBack(() => ({ body, subject }));
		showToast(t('dashboard.inbox.detail.followUpUndoneToast'));
		openReply();
	} finally {
		undoingFollowUpId.value = null;
	}
}

// The reject confirm (InboxRejectDraftModal) owns the reason and the busy state.
const openRejectModal = (messageId: Id<'inboundMessages'>) => {
	actionMessageId.value = messageId;
	showRejectModal.value = true;
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

// Auto-close: the rule's state for this thread, the header's switch and Reopen.
const { autoClose, autoCloseSwitch, autoCloseFact, isReopening, onReopen, onAutoClose } =
	useTeamThreadAutoClose({ threadId, isAdmin, detail });

// Chat channels that discuss this thread, and a new one linked to it.
const { chatEnabled, discussionChannels, showNewChannel, onChannelCreated } =
	useTeamThreadDiscussionChannels(threadId);
</script>

<template>
	<div class="mx-auto w-full p-6 lg:p-8" :class="isZen ? 'max-w-4xl' : 'max-w-page'">
		<!-- Back navigation, in Zen only: elsewhere the breadcrumb trail above
		     already leads back to the team inbox. -->
		<NuxtLink
			v-if="isZen"
			to="/dashboard/inbox"
			class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors mb-6"
		>
			<ArrowLeftIcon class="w-4 h-4" />
			{{ t('dashboard.inbox.detail.backToInbox') }}
		</NuxtLink>

		<!-- A failed read is not a missing thread. -->
		<UiQueryBoundary v-if="threadError" :error="threadError" @retry="refetchThread" />

		<!-- Loading: the page's own shape, headed by the list row when we have it. -->
		<InboxThreadDetailSkeleton v-else-if="threadLoading && !thread" :preview="threadPreview" />

		<!-- Not Found -->
		<div v-else-if="!thread" class="flex flex-col items-center justify-center py-16 text-center">
			<UiIconBox
				:icon="CircleWarningIcon"
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
			<!-- The actions stay a sibling of the header rather than its #actions:
			     their row does not wrap and is wider than the header's actions cap
			     next to an expanded sidebar, so it would run into the subject. Here
			     the subject keeps at least 24rem and the actions drop below it. -->
			<div class="mb-6 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
				<!-- The subject, once. Messages below don't repeat it. -->
				<InboxThreadPageHeader
					:subject="thread.subject"
					:contact="contact"
					:message-count="thread.messageCount"
					:priority="priority"
					:snoozed-until="isSnoozed ? thread.snoozedUntil : null"
					:presence-people="presencePeople"
				/>

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
					:auto-close="autoCloseSwitch"
					@reply="openReply()"
					@assign="onAssign"
					@new-channel="showNewChannel = true"
					@snooze="showSnoozeDialog = true"
					@unsnooze="onUnsnooze"
					@status="handleStatusChange"
					@auto-close="onAutoClose"
					@copy-link="copyThreadLink"
					@share-in-chat="showShareInChat = true"
				/>
			</div>

			<InboxAutoClosedNotice
				v-if="isAutoClosed(thread) && thread.autoClosedAt"
				:auto-closed-at="thread.autoClosedAt"
				:quiet-days="autoClose?.autoClosedQuietDays ?? null"
				:can-reopen="isAdmin"
				:busy="isReopening"
				@reopen="onReopen"
			/>

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
			<LazyChatLinkEmailDialog
				v-if="showShareInChat && chatEnabled"
				:conversation="{ kind: 'team', threadId }"
				audience="team"
				@close="showShareInChat = false"
			/>

			<!-- From xl the side column keeps a fixed width instead of a third of an
			     ever wider page. -->
			<div
				class="grid grid-cols-1 gap-6"
				:class="isZen ? '' : 'lg:grid-cols-3 xl:grid-cols-[minmax(0,1fr)_20rem]'"
			>
				<!-- The thread as one stream; the open actions pinned above it. -->
				<div
					v-reply-drop="replyDrop"
					class="space-y-4"
					:class="isZen ? '' : 'lg:col-span-2 xl:col-span-1'"
					data-testid="team-thread-main"
				>
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
						:icon="MailIcon"
						:title="t('dashboard.inbox.detail.noMessages')"
					/>

					<!-- Internal note or Reply to the customer (Answer mode), each with its own draft. -->
					<AppErrorBoundary v-if="isAdmin" surface="composer">
						<TeamNoteComposer
							ref="composer"
							v-model:reply-draft="replyDraft"
							:draft-key="teamNoteDraftKey(threadId)"
							:reply-name="replyTarget ? replySenderLabel : null"
							:items="team.items.value"
							:candidates-for="team.candidatesFor"
							:submit-note="team.postNote"
							@reply="openReply()"
						/>
					</AppErrorBoundary>
				</div>

				<InboxThreadSidebar
					v-if="!isZen"
					:thread-id="threadId"
					:contact="contact"
					:message-count="thread.messageCount"
					:assigned-to="thread.assignedTo"
					:assigned-member-name="assignedMemberName"
					:last-message-at="thread.lastMessageAt"
					:auto-close-fact="autoCloseFact"
				/>
			</div>
		</template>

		<!-- Reject Modal -->
		<InboxRejectDraftModal
			v-model:open="showRejectModal"
			:message-id="actionMessageId"
			:reject="handleReject"
		/>
	</div>
</template>
