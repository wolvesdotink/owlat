<script setup lang="ts">
import TaskAsk from '~/components/agent-tasks/TaskAsk.vue';
import TaskOptions from '~/components/agent-tasks/TaskOptions.vue';
import { canonicalOption, localizedQuestionCopy } from '~/utils/clarificationLocale';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { useOrganization } from '~/composables/useOrganization';
import {
	GENERIC_TEAMMATE_NAME,
	isReplyCollision,
	replyCollisionToast,
	sendHoldReason,
} from '~/utils/replyCollision';
import { capitalize, formatRelativeTime } from '~/utils/formatters';
import {
	classificationSummary,
	hasAgentDraft,
	latestClassification,
	needsTakeOver,
	pickReplyTarget,
	replyBlocker,
} from '~/utils/teamThreadReply';
import { isApproveAlreadyHandled } from '~/composables/useReviewApproveUndo';
import { isEditableTarget } from '~/utils/postboxShortcuts';

const { t, te, locale } = useI18n();

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
	editedDraftResponse,
	editedDraftSubject,
	handleApprove,
	handleReject,
	handleRetry,
	saveEditedDraft,
	saveDraftOnly,
	handleStatusChange,
	handleSnooze,
	handleUnsnooze,
	handleAssign,
} = useThreadDetail(threadId);
const { isEnabled: isFeatureEnabled } = useFeatureFlag();

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
// `r` opens the reply composer, as the shortcut sheet promises.
function onThreadKeydown(event: KeyboardEvent) {
	const key = event.key.toLowerCase();
	if (key !== 'i' && key !== 'r') return;
	if (event.metaKey || event.ctrlKey || event.altKey) return;
	// Never hijack typing in an input / textarea / contenteditable.
	if (isEditableTarget(event.target)) return;
	event.preventDefault();
	if (key === 'i') assignToMe();
	else openReply();
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

// Live thread presence — heartbeat while this thread is open, flip to "replying"
// while the person is writing in the composer. `others` excludes the current user; resolve
// each to a display name/avatar via the already-fetched org members.
const composerTyping = ref(false);
const { others: presenceOthers } = useThreadPresence(threadId, { replying: composerTyping });
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
const isRejecting = ref(false);
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

// The question in the reader's own language (canonical English when no
// translation landed); chip picks are mapped back to the canonical option on
// submit so the persisted answer matches what answer-memory expects.
type ThreadClarificationQuestion = NonNullable<
	NonNullable<typeof messages.value>[number]['pendingClarification']
>['questions'][number];
function questionCopy(question: ThreadClarificationQuestion) {
	return localizedQuestionCopy(question, locale.value);
}

/**
 * The answer Owlat pre-picked from the person's earlier answer to the same
 * question (answer-memory, source 'memory'), shown in the reader's locale so it
 * matches the chip it highlights. The person stays in charge: it is only a
 * pre-selection, and picking anything else replaces it.
 */
function rememberedAnswer(question: ThreadClarificationQuestion): string | undefined {
	if (question.answer?.source !== 'memory') return undefined;
	const index = question.options?.indexOf(question.answer.value) ?? -1;
	return index >= 0 ? questionCopy(question).options[index] : question.answer.value;
}

// Seed the working answers with the remembered ones once per message, so the
// "Answer and resume" button is live for a card whose questions memory already
// answered and the person only has to confirm (or change) them.
watch(
	messages,
	(list) => {
		for (const message of list ?? []) {
			if (message.processingStatus !== 'awaiting_clarification') continue;
			for (const question of message.pendingClarification?.questions ?? []) {
				const remembered = rememberedAnswer(question);
				if (remembered === undefined) continue;
				const answers = (clarificationAnswers[message._id] ??= {});
				if (answers[question.id] === undefined) answers[question.id] = remembered;
			}
		}
	},
	{ immediate: true }
);

/** How many of a parked message's questions currently carry an answer. */
function answeredCount(message: NonNullable<typeof messages.value>[number]): number {
	const answers = clarificationAnswers[message._id] ?? {};
	return (message.pendingClarification?.questions ?? []).filter((q) => answers[q.id]?.trim())
		.length;
}

/** The sender's language as a readable name in the reader's locale ("German"). */
function replyLanguageName(code: string | undefined): string | undefined {
	if (!code) return undefined;
	try {
		return new Intl.DisplayNames([locale.value], { type: 'language' }).of(code) ?? code;
	} catch {
		return code;
	}
}

/** Questions answered from memory on a message that already has its draft. */
function reusedAnswers(message: NonNullable<typeof messages.value>[number]) {
	return (message.pendingClarification?.questions ?? []).filter(
		(q) => q.answer?.source === 'memory'
	);
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
			value: canonicalOption(question, locale.value, values[question.id]?.trim() ?? ''),
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

// ── Reply composer ──
// The composer answers one message: the newest still waiting for a reply,
// otherwise the newest message (whose state then says why nothing can go out).
const replyTarget = computed(() => pickReplyTarget(messages.value));
const replyTargetBlocker = computed(() =>
	replyTarget.value
		? replyBlocker(replyTarget.value.processingStatus, {
				agentEnabled: isFeatureEnabled('ai.agent'),
			})
		: null
);
// A message the agent failed (or, with the agent off, never drafts) is taken
// over first, so the normal edit → approve path can send a person's reply.
const { run: takeOverReply } = useBackendOperation(api.inbox.manualReply.takeOverReply, {
	label: () => t('dashboard.inbox.detail.takeOverOperation'),
});
const replyDraft = computed(() =>
	replyTarget.value && hasAgentDraft(replyTarget.value)
		? (replyTarget.value.draftResponse ?? null)
		: null
);
const replyOriginalDraft = computed(() =>
	replyTarget.value && replyDraft.value ? agentOriginalDraft(replyTarget.value) : null
);
const replySenderLabel = computed(() => {
	if (contact.value) {
		const name = `${contact.value.firstName ?? ''} ${contact.value.lastName ?? ''}`.trim();
		return name || contact.value.email;
	}
	return replyTarget.value?.from ?? '';
});
const composerOpen = ref(false);
const composerRef = ref<{ focus: () => void; reset: () => void } | null>(null);
const isSending = ref(false);

function openReply() {
	composerRef.value?.focus();
}

/** A refused send: a teammate just replied, or someone handled it first. */
function refusedSend(result: unknown): boolean {
	if (isReplyCollision(result)) {
		showToast(
			collisionText(replyCollisionToast(result.heldByName ?? t(GENERIC_TEAMMATE_NAME))),
			'error'
		);
		return true;
	}
	if (isApproveAlreadyHandled(result)) {
		showToast(t('shared.reviewApprove.alreadyHandled'), 'info');
		return true;
	}
	return false;
}

/**
 * Send from the composer. An unchanged agent draft is a plain approve (the fast
 * path); anything typed is saved as the working draft first and then approved —
 * the same edit → approve path the Answer queue's "Write my own" takes.
 */
const onComposerSend = async (body: string, fromDraft: boolean) => {
	const target = replyTarget.value;
	if (!target || isHeld.value || isSending.value) return;
	isSending.value = true;
	try {
		if (needsTakeOver(target.processingStatus)) {
			const takenOver = await takeOverReply({ inboundMessageId: target._id });
			if (!takenOver.ok) return;
		}
		let result;
		if (fromDraft) {
			result = await handleApprove(target._id);
		} else {
			editedDraftResponse.value = body;
			editedDraftSubject.value = target.draftSubject ?? '';
			result = await saveEditedDraft(target._id);
		}
		if (!result.ok || refusedSend(result.result)) return;
		composerRef.value?.reset();
		composerOpen.value = false;
		showToast(t('dashboard.inbox.detail.replySentToast'));
	} finally {
		isSending.value = false;
	}
};

// Save WITHOUT sending: persist the edit as a draft revision. The message stays
// waiting for review ("Saved · edited by you"); no collision hold applies
// because nothing is sent.
const onComposerSave = async (body: string) => {
	const target = replyTarget.value;
	if (!target) return;
	isSending.value = true;
	try {
		editedDraftResponse.value = body;
		editedDraftSubject.value = target.draftSubject ?? '';
		const result = await saveDraftOnly(target._id);
		if (result.ok) showToast(t('dashboard.inbox.detail.toasts.draftSavedNotApproved'));
	} finally {
		isSending.value = false;
	}
};

// An update the classifier filed as needing no reply can be sent to drafting
// after all; the draft then opens in the composer.
const { run: requestReply, isLoading: isRequestingReply } = useBackendOperation(
	api.inbox.updates.requestReply,
	{ label: () => t('dashboard.inbox.detail.requestReplyOperation') }
);
async function onRequestReply() {
	const target = replyTarget.value;
	if (!target || !isAdmin.value) return;
	const result = await requestReply({ inboundMessageId: target._id });
	if (result.ok) showToast(t('dashboard.inbox.detail.replyRequestedToast'));
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
		if (result.ok) showToast(t('dashboard.inbox.detail.retriedToast'));
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

/**
 * The status picker is a pill menu, not a native `<select>`: it sits at the end
 * of a row of pill controls (Discuss / Assign / Snooze) and an input-styled
 * rectangle with a native chevron broke that rhythm — and skipped the shared
 * control treatment (press feedback, tiered motion) its neighbours all get.
 */
const statusMenuOpen = ref(false);
// The assignee popover takes `open` as a controlled prop (same as the list
// row's picker); unbound, its trigger toggled a value nothing read back.
const assignMenuOpen = ref(false);
// Narrow screens keep one primary action (Reply) in the header; everything
// else moves into this overflow menu instead of wrapping off the edge.
const moreMenuOpen = ref(false);
const assignedToMe = computed(() => !!user.value?.id && thread.value?.assignedTo === user.value.id);
function toggleAssignToMe() {
	if (assignedToMe.value) void handleAssign(undefined);
	else assignToMe();
}
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
			<div class="flex items-start justify-between gap-4 mb-6">
				<div class="min-w-0">
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

				<!-- Actions. Reply is the one primary action; on a narrow screen the
				     rest folds into the ⋯ menu instead of wrapping off the edge. -->
				<div class="flex shrink-0 items-center gap-2">
					<UiButton
						v-if="isAdmin"
						size="sm"
						class="gap-1.5"
						data-testid="thread-reply"
						:aria-keyshortcuts="'r'"
						@click="openReply"
					>
						<Icon name="lucide:reply" class="w-4 h-4" />
						{{ t('dashboard.inbox.detail.reply') }}
					</UiButton>

					<div class="hidden sm:flex items-center gap-2">
						<template v-if="chatEnabled">
							<NuxtLink
								v-for="channel in discussionChannels"
								:key="channel._id"
								:to="`/dashboard/chat/${channel._id}`"
								class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-brand-subtle text-brand hover:bg-brand-subtle/70 transition-colors"
								:title="
									t('dashboard.inbox.detail.discussInChannelTitle', { channel: channel.name })
								"
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
						</template>
						<!-- Assignee picker — avatar popover (Me / members / Unassign).
						     `open` is a controlled prop: without the binding the popover
						     can never open (the row's picker models it the same way). -->
						<InboxAssignPopover
							v-model:open="assignMenuOpen"
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
							v-if="isSnoozed"
							variant="secondary"
							size="sm"
							class="gap-1.5"
							@click="onUnsnooze"
						>
							<Icon name="lucide:alarm-clock-off" class="w-4 h-4" />
							{{ t('dashboard.inbox.detail.unsnooze') }}
						</UiButton>
						<UiButton
							v-else
							variant="secondary"
							size="sm"
							class="gap-1.5"
							@click="showSnoozeDialog = true"
						>
							<Icon name="lucide:alarm-clock" class="w-4 h-4" />
							{{ t('dashboard.inbox.detail.snooze') }}
						</UiButton>
						<!-- The ONE status control. The agent's processing state is a
						     hint on the reply composer, not a second status. -->
						<UiDropdownMenu v-model:open="statusMenuOpen" position="right">
							<template #trigger>
								<UiButton
									variant="secondary"
									size="sm"
									type="button"
									class="gap-1.5"
									data-testid="thread-status"
									:aria-label="t('dashboard.inbox.detail.changeStatusAria')"
								>
									{{ t(`dashboard.inbox.detail.statuses.${currentStatus}`) }}
									<template #iconRight>
										<Icon name="lucide:chevron-down" class="w-4 h-4 text-text-tertiary" />
									</template>
								</UiButton>
							</template>
							<UiDropdownMenuItem
								v-for="s in statusOptions"
								:key="s"
								@click="handleStatusChange(s)"
							>
								<span class="flex-1 truncate">
									{{ t(`dashboard.inbox.detail.statuses.${s}`) }}
								</span>
								<Icon
									v-if="s === currentStatus"
									name="lucide:check"
									class="w-4 h-4 text-brand shrink-0"
								/>
							</UiDropdownMenuItem>
						</UiDropdownMenu>
					</div>

					<!-- Narrow screens: everything but Reply in one menu. -->
					<UiDropdownMenu v-model:open="moreMenuOpen" position="right" class="sm:hidden">
						<template #trigger>
							<UiButton
								variant="secondary"
								size="sm"
								type="button"
								data-testid="thread-more"
								:aria-label="t('dashboard.inbox.detail.moreActions')"
							>
								<Icon name="lucide:ellipsis" class="w-4 h-4" />
							</UiButton>
						</template>
						<template v-if="chatEnabled">
							<UiDropdownMenuItem
								v-for="channel in discussionChannels"
								:key="channel._id"
								@click="router.push(`/dashboard/chat/${channel._id}`)"
							>
								<Icon name="lucide:message-circle" class="w-4 h-4 shrink-0" />
								<span class="flex-1 truncate">#{{ channel.name }}</span>
							</UiDropdownMenuItem>
							<UiDropdownMenuItem
								v-if="discussionChannels.length === 0"
								@click="showNewChannel = true"
							>
								<Icon name="lucide:message-circle-plus" class="w-4 h-4 shrink-0" />
								<span class="flex-1 truncate">{{
									t('dashboard.inbox.detail.discussInChannel')
								}}</span>
							</UiDropdownMenuItem>
						</template>
						<UiDropdownMenuItem v-if="isAdmin" @click="toggleAssignToMe">
							<Icon
								:name="assignedToMe ? 'lucide:user-minus' : 'lucide:user-plus'"
								class="w-4 h-4 shrink-0"
							/>
							<span class="flex-1 truncate">
								{{
									assignedToMe
										? t('dashboard.inbox.detail.unassignMe')
										: t('dashboard.inbox.detail.assignToMe')
								}}
							</span>
						</UiDropdownMenuItem>
						<UiDropdownMenuItem v-if="isSnoozed" @click="onUnsnooze">
							<Icon name="lucide:alarm-clock-off" class="w-4 h-4 shrink-0" />
							<span class="flex-1 truncate">{{ t('dashboard.inbox.detail.unsnooze') }}</span>
						</UiDropdownMenuItem>
						<UiDropdownMenuItem v-else @click="showSnoozeDialog = true">
							<Icon name="lucide:alarm-clock" class="w-4 h-4 shrink-0" />
							<span class="flex-1 truncate">{{ t('dashboard.inbox.detail.snooze') }}</span>
						</UiDropdownMenuItem>
						<UiDropdownMenuItem v-for="s in statusOptions" :key="s" @click="handleStatusChange(s)">
							<span class="flex-1 truncate">
								{{ t(`dashboard.inbox.detail.markAs.${s}`) }}
							</span>
							<Icon
								v-if="s === currentStatus"
								name="lucide:check"
								class="w-4 h-4 text-brand shrink-0"
							/>
						</UiDropdownMenuItem>
					</UiDropdownMenu>
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
						<div class="flex items-center gap-3 mb-4">
							<UiIconBox icon="lucide:mail" size="sm" variant="surface" rounded="full" />
							<div class="min-w-0">
								<p class="text-text-primary font-medium text-sm truncate">{{ message.from }}</p>
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

						<!-- Message Body -->
						<div class="text-text-secondary text-sm whitespace-pre-wrap">
							{{ message.textBody || t('dashboard.inbox.detail.noTextContent') }}
						</div>

						<!-- Attachments. getThread returns the row unprojected, so the
						     list needs no extra query; the component owns the download. -->
						<InboxMessageAttachments :message="message" />

						<!-- Failure reason + manual retry (terminal 'failed' state) -->
						<div
							v-if="message.processingStatus === 'failed'"
							class="mt-4 p-3 bg-error-subtle rounded-lg"
						>
							<p class="text-xs text-error font-medium mb-2">
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
							class="mt-4 surface-2 rounded-(--radius-card) border-l-2 border-l-brand/60 p-5"
							data-testid="thread-clarification"
						>
							<div class="flex items-start justify-between gap-4">
								<div>
									<span class="lp-eyebrow">{{
										t('dashboard.inbox.detail.agentNeedsInputEyebrow')
									}}</span>
									<p class="mt-1 text-md font-semibold text-text-primary">
										{{ t('dashboard.inbox.detail.agentNeedsInput') }}
									</p>
									<p class="mt-1 text-sm text-text-secondary max-w-[540px]">
										{{ t('dashboard.inbox.detail.clarificationLead') }}
										<template v-if="replyLanguageName(message.classification?.language)">
											{{
												t('dashboard.inbox.detail.replyLanguageNote', {
													language: replyLanguageName(message.classification?.language),
												})
											}}
										</template>
									</p>
								</div>
								<span
									class="shrink-0 inline-flex items-center gap-1.5 rounded-full surface-1 px-2.5 py-1 text-2xs font-medium text-text-secondary"
									data-testid="thread-clarification-progress"
								>
									<Icon name="lucide:message-circle-question" class="h-3 w-3 text-brand" />
									{{
										t('dashboard.inbox.detail.clarificationProgress', {
											answered: answeredCount(message),
											total: message.pendingClarification.questions.length,
										})
									}}
								</span>
							</div>
							<div class="mt-5 space-y-5">
								<div
									v-for="(question, questionIndex) in message.pendingClarification.questions"
									:key="question.id"
									data-testid="thread-clarification-question"
									class="border-t border-border-subtle pt-4"
								>
									<p class="lp-eyebrow mb-1.5">
										{{
											t('dashboard.inbox.detail.questionCounter', {
												index: questionIndex + 1,
												total: message.pendingClarification.questions.length,
											})
										}}
									</p>
									<TaskAsk :ask="questionCopy(question).text" />
									<TaskOptions
										class="mt-1.5"
										:model-value="clarificationAnswers[message._id]?.[question.id] ?? ''"
										:options="questionCopy(question).options"
										:remembered="rememberedAnswer(question)"
										:placeholder="t('dashboard.inbox.detail.answerPlaceholder')"
										chip-test-id="thread-clarification-chip"
										input-test-id="thread-clarification-input"
										@update:model-value="
											(value: string) => setClarificationAnswer(message._id, question.id, value)
										"
										@submit="hasEveryClarificationAnswer(message) && submitClarification(message)"
									/>
								</div>
								<div class="flex items-center gap-3 pt-1">
									<UiButton
										size="sm"
										:loading="isAnsweringClarification"
										:disabled="!hasEveryClarificationAnswer(message)"
										@click="submitClarification(message)"
									>
										<Icon name="lucide:sparkles" class="w-3.5 h-3.5" />
										{{ t('dashboard.inbox.detail.answerAndResume') }}
									</UiButton>
									<p
										v-if="!hasEveryClarificationAnswer(message)"
										class="text-xs text-text-tertiary"
										data-testid="thread-clarification-remaining"
									>
										{{
											t(
												'dashboard.inbox.detail.answerRemaining',
												{
													count:
														message.pendingClarification.questions.length - answeredCount(message),
												},
												message.pendingClarification.questions.length - answeredCount(message)
											)
										}}
									</p>
								</div>
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

						<!-- The agent's working, for admins, behind one disclosure. -->
						<InboxAgentInsight
							v-if="isAdmin && (message.classification || message.processingStatus !== 'received')"
							:inbound-message-id="message._id"
							:classification="message.classification ?? null"
							:decision-reason="message.agentDecision?.reason ?? null"
						/>
					</div>

					<!-- Empty messages -->
					<UiEmptyState
						v-if="messages.length === 0"
						icon="lucide:mail"
						:title="t('dashboard.inbox.detail.noMessages')"
					/>

					<!-- Answers the agent reused from memory for the draft below. -->
					<div
						v-if="
							replyTarget &&
							replyTarget.processingStatus === 'draft_ready' &&
							reusedAnswers(replyTarget).length > 0
						"
						class="surface-1 rounded-(--radius-card) p-4"
						data-testid="reused-answers"
					>
						<span class="lp-eyebrow">{{ t('dashboard.inbox.detail.reusedAnswersEyebrow') }}</span>
						<p class="mt-1 text-sm font-medium text-text-primary">
							{{ t('dashboard.inbox.detail.reusedAnswersTitle') }}
						</p>
						<ul class="mt-2 space-y-1.5 text-sm">
							<li
								v-for="question in reusedAnswers(replyTarget)"
								:key="question.id"
								class="flex items-baseline gap-2"
							>
								<Icon
									name="lucide:history"
									class="w-3.5 h-3.5 shrink-0 translate-y-0.5 text-text-tertiary"
								/>
								<span class="text-text-secondary">{{ questionCopy(question).text }}</span>
								<span class="font-medium text-text-primary">{{ question.answer?.value }}</span>
							</li>
						</ul>
						<p class="mt-2 text-xs text-text-tertiary">
							{{ t('dashboard.inbox.detail.reusedAnswersHint') }}
							<NuxtLink
								to="/dashboard/admin/instance/autonomy"
								class="underline hover:text-text-primary"
								>{{ t('dashboard.inbox.detail.reusedAnswersManage') }}</NuxtLink
							>
						</p>
					</div>

					<!-- Reply composer: on every thread, pre-filled with the agent's
					     draft when there is one. -->
					<InboxThreadComposer
						v-if="isAdmin && replyTarget"
						ref="composerRef"
						v-model:open="composerOpen"
						:sender-label="replySenderLabel"
						:blocker="replyTargetBlocker"
						:draft="replyDraft"
						:original-draft="replyOriginalDraft"
						:busy="isSending"
						:held="isHeld"
						:held-reason="holdReason"
						@send="onComposerSend"
						@save="onComposerSave"
						@reject="openRejectModal(replyTarget._id)"
						@typing="composerTyping = $event"
					>
						<template v-if="replyTargetBlocker === 'update'" #blocked-action>
							<UiButton
								variant="secondary"
								size="sm"
								:loading="isRequestingReply"
								@click="onRequestReply"
							>
								<Icon name="lucide:sparkles" class="w-3.5 h-3.5" />
								{{ t('dashboard.inbox.detail.requestReply') }}
							</UiButton>
						</template>
					</InboxThreadComposer>
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
