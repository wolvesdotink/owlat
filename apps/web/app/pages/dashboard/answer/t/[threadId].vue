<script setup lang="ts">
/**
 * Answer mode for a Team inbox thread: one reply, the whole screen (plan §07).
 *
 *   /dashboard/answer/t/<conversationThreadId>?message=<inboundMessageId>
 *
 * The conversation on the left (HTML bodies through the Postbox body
 * component), the team reply on the right: the agent's draft opens in the
 * editor, the agent's questions sit above it, the files below it. The top bar
 * says who the reply goes out as ("Answering as Team inbox") and who else is
 * here ("Priya is viewing"); while a teammate is replying, Send is held and
 * says so. `?message=` picks the message the reply answers when it is not the
 * newest one waiting.
 *
 * The thread page keeps assignment, status and the discussion; its Reply and
 * `r` open this route. Leaving (Esc, "← Team inbox", or a send) goes back to
 * the page the reply started from; text typed and not sent is kept for this
 * thread until the reply is written.
 *
 * Keys: Esc leaves (inside the editor the first Esc only blurs it), `t`
 * toggles Summary / Full conversation, `n` opens the Note tab (the team's
 * internal notes, which never reach the reply), Cmd/Ctrl+J focuses the reply.
 */
import type { PresencePerson } from '~/components/inbox/InboxThreadPresence.vue';
import type { AnswerConversationView } from '~/components/answer/AnswerConversation.vue';
import { useAnswerAiFocus, useAnswerModeNav } from '~/composables/useAnswerMode';
import type { AnswerComposerApi } from '~/composables/postbox/usePostboxComposerAnswerApi';
import type { AskAnswer, AskQuestion } from '~/composables/useAnswerAskSession';
import { useAnswerTeamAssist } from '~/composables/useAnswerTeamAssist';
import CatchUpCard from '~/components/answer/CatchUpCard.vue';
import AnswerAiBar from '~/components/answer/AnswerAiBar.vue';
import AskCard from '~/components/answer/AskCard.vue';
import type { FileCopyPolicy } from '~/components/answer/FileAsk.vue';
import { useAnswerQueueSession } from '~/composables/useAnswerQueueSession';
import { useAnswerTeamReply } from '~/composables/useAnswerTeamReply';
import { useTeamReplyAttachments } from '~/composables/useTeamReplyAttachments';
import { useTeamKeptReply } from '~/composables/useTeamKeptReply';
import { useOrganization } from '~/composables/useOrganization';
import { useLocalized } from '~/composables/useLocalized';
import { answerBackLabelKey, singleQueryValue } from '~/utils/answerMode';
import { sendHoldReason } from '~/utils/replyCollision';
import { isChannelMessage } from '~/utils/teamThreadReply';
import { isDialogOpen } from '~/utils/dialogOpen';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import { isChordPending } from '~/utils/shortcutScope';
import { isImeComposing } from '~/utils/imeComposition';

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'inbox',
	answerMode: true,
});

const { t, locale } = useI18n();
const route = useRoute();

const threadId = useRouteId<'conversationThreads'>('threadId');
const detail = useThreadDetail(threadId);
const { thread, messages, contact, followUps, threadLoading, threadError, cancelFollowUp } = detail;

useHead({ title: () => thread.value?.subject || t('dashboard.answer.mode.pageTitle') });

// People: presence and the collision hold
const { members, fetchMembers } = useOrganization();
const { isAdmin, canManageOrganization } = usePermissions();
// An uploaded file answer is kept in Files only by someone who may add to
// Files, and only for the thread's contact (lib/answerFileToFiles.ts).
const copyPolicy = computed<FileCopyPolicy>(() =>
	canManageOrganization.value && contact.value ? 'kept' : 'never'
);
onMounted(() => void fetchMembers());
function memberName(userId: string): string {
	const m = members.value.find((x) => x.userId === userId);
	return m ? m.user.name || m.user.email : t('dashboard.inbox.detail.outbound.yourTeam');
}

const composerTyping = ref(false);
const { others: presenceOthers } = useThreadPresence(threadId, { replying: composerTyping });
const presencePeople = computed<PresencePerson[]>(() =>
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
// While another teammate is replying, Send is held (visible, labelled with
// who); it releases on its own when their presence drops, and the server
// re-checks at send time.
const heldBy = computed(
	() => presencePeople.value.find((p) => p.mode === 'replying')?.name ?? null
);
const localized = useLocalized();
const holdReason = computed(() =>
	heldBy.value ? localized(sendHoldReason(heldBy.value)) : undefined
);

const reply = useAnswerTeamReply({
	threadId,
	detail,
	chosenMessageId: () => singleQueryValue(route.query['message']),
	held: () => heldBy.value !== null,
});
// A reply on another channel (SMS, WhatsApp) carries no files.
const attachmentsAllowed = computed(
	() => isAdmin.value && !!reply.target.value && !isChannelMessage(reply.target.value)
);
const files = useTeamReplyAttachments(() => threadId.value, {
	enabled: () => attachmentsAllowed.value,
});
const sendHold = computed(() => {
	const block = attachmentsAllowed.value ? files.block.value : null;
	return block ? t(`components.answer.team.attachments.hold.${block}`) : null;
});

// A shallowRef: the reply's `answer` API holds refs its users read as refs.
const composerRef = shallowRef<{
	focus: () => void;
	reset: () => void;
	fill: (body: string, subject: string) => void;
	snapshot: () => { body: string; subject: string; touched: boolean };
	answer: AnswerComposerApi;
} | null>(null);

const tab = ref<'conversation' | 'reply'>('conversation');
const composeMode = ref<'reply' | 'note'>('reply');
const threadNotes = useThreadNotes(threadId, { enabled: () => isAdmin.value });
const view = ref<AnswerConversationView>('summary');

// Catch-up, Draft with AI, and the agent's questions
const assist = useAnswerTeamAssist({
	threadId: () => threadId.value,
	composer: () => composerRef.value?.answer ?? null,
	messageCount: () => (thread.value ? messages.value.length : undefined),
	view,
	// A reply on another channel carries no files: the server would refuse.
	attachFile: (file) => {
		if (attachmentsAllowed.value) void files.attachAnswerFile(file);
	},
});
const catchUpMessages = computed(() =>
	messages.value.map((m) => ({ _id: m._id, receivedAt: m._creationTime, fromAddress: m.from }))
);
// The agent's questions carry the clarification question shape the ask card
// takes (lib/validators/clarification.ts).
const clarificationQuestions = computed(
	() => (reply.clarification.value?.questions ?? []) as unknown as AskQuestion[]
);
// The sender's language as a readable name in the reader's locale ("German").
const replyLanguage = computed(() => {
	const code = reply.target.value?.classification?.language;
	if (!code) return undefined;
	try {
		return new Intl.DisplayNames([locale.value], { type: 'language' }).of(code) ?? code;
	} catch {
		return code;
	}
});
// "Answer later" puts the agent's questions away; the editor stays.
const clarificationDeferred = ref(false);
const showClarification = computed(
	() => !!reply.clarification.value && !clarificationDeferred.value
);
// A file given as an answer goes on the reply on the server, in the same
// transaction as the answer (inbox.clarification.answerClarification); the
// attachment list then updates through its subscription.
async function onClarificationAnswers(answers: AskAnswer[]) {
	await reply.submitClarification(answers);
}

/** The resting phone/tablet sheet's "✦ Draft": open the reply and draft with AI. */
function draftFromPeek() {
	tab.value = 'reply';
	void assist.ask.start('');
}

// Text typed and not sent stays with the thread for the session, so leaving
// and coming back never throws it away (the team reply has no autosave row).
const keptReply = useTeamKeptReply();
watch(composerRef, (composer) => {
	const kept = keptReply.get(threadId.value);
	if (composer && kept) composer.fill(kept.body, kept.subject);
});
function keepTyped() {
	const snapshot = composerRef.value?.snapshot();
	keptReply.set(
		threadId.value,
		snapshot?.touched ? { body: snapshot.body, subject: snapshot.subject } : null
	);
}

const answerNav = useAnswerModeNav({ currentPath: () => route.path });
const queueSession = useAnswerQueueSession();
const backLabel = computed(() => t(answerBackLabelKey(answerNav.returnPath.value)));

// However the page is left (Esc, a link, the queue moving on), keep the text.
onBeforeUnmount(keepTyped);

function leave() {
	answerNav.leave();
}

async function onSend(body: string, fromDraft: boolean, subject: string) {
	const sent = await reply.send({ body, subject }, fromDraft);
	if (!sent) return;
	composerRef.value?.reset();
	keptReply.set(threadId.value, null);
	if (queueSession?.handleSent('sent')) return;
	answerNav.leave();
}

async function onConfirmReject() {
	if (!(await reply.reject.confirmReject())) return;
	// In the queue, discarding the agent's draft finishes the item; outside it,
	// the editor stays open for the person's own reply.
	if (queueSession?.isCurrentRoute.value) queueSession.complete('rejected');
}

const undoingFollowUpId = ref<string | null>(null);
async function undoFollowUp(followUpId: Parameters<typeof cancelFollowUp>[0]) {
	if (undoingFollowUpId.value) return;
	undoingFollowUpId.value = followUpId;
	try {
		const result = await cancelFollowUp(followUpId);
		if (!result.ok || !result.result.cancelled) return;
		// Hand the text back so nothing typed is lost.
		composerRef.value?.fill(result.result.body, result.result.subject);
	} finally {
		undoingFollowUpId.value = null;
	}
}

function onKeydown(event: KeyboardEvent) {
	if (event.defaultPrevented || isImeComposing(event)) return;
	if (event.key === 'Escape') {
		if (isDialogOpen()) return;
		event.preventDefault();
		const active = document.activeElement;
		if (isEditableTarget(active) && active instanceof HTMLElement) active.blur();
		else leave();
		return;
	}
	const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
	if (
		plain &&
		(event.key === 't' || event.key === 'T' || event.key === 'n' || event.key === 'N') &&
		!isEditableTarget(event.target) &&
		!isChordPending() &&
		!isDialogOpen()
	) {
		event.preventDefault();
		if (event.key.toLowerCase() !== 'n') view.value = view.value === 'summary' ? 'full' : 'summary';
		else if (isAdmin.value) [tab.value, composeMode.value] = ['reply', 'note'];
	}
}
const aiFocus = useAnswerAiFocus();
/** Cmd/Ctrl+J focuses "Draft with AI" (or the reply) instead of opening the Assistant. */
function onChordCapture(event: KeyboardEvent) {
	if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
	if (event.key.toLowerCase() !== 'j') return;
	event.preventDefault();
	event.stopPropagation();
	tab.value = 'reply';
	composeMode.value = 'reply';
	if (!aiFocus.request()) composerRef.value?.focus();
}
onMounted(() => {
	window.addEventListener('keydown', onKeydown);
	window.addEventListener('keydown', onChordCapture, true);
});
onBeforeUnmount(() => {
	window.removeEventListener('keydown', onKeydown);
	window.removeEventListener('keydown', onChordCapture, true);
});
</script>

<template>
	<div>
		<AnswerModeFrame
			v-model:tab="tab"
			:back-label="backLabel"
			:subject="thread?.subject ?? ''"
			:message-count="thread ? messages.length : undefined"
			:counterpart="reply.senderLabel.value"
			:counterpart-to="contact ? `/dashboard/audience/contacts/${contact._id}` : undefined"
			@back="leave"
			@start-reply="composerRef?.focus()"
		>
			<template #identity>
				<span class="flex min-w-0 items-center gap-3" data-testid="answer-identity">
					<span class="flex min-w-0 items-center gap-1.5 text-xs text-text-secondary">
						<Icon name="lucide:bot" class="size-3.5 shrink-0 text-text-tertiary" />
						<span class="truncate">
							{{
								t('components.answer.band.answeringAs', { name: t('components.shell.teamInbox') })
							}}
						</span>
					</span>
					<AnswerTeamPresence :people="presencePeople" />
				</span>
			</template>
			<template #queue>
				<AnswerQueueBar />
			</template>
			<template #menu>
				<PostboxOverflowMenu :label="t('components.answer.mode.more')" align="right">
					<template #default="{ close }">
						<NuxtLink
							:to="`/dashboard/inbox/${threadId}`"
							role="menuitem"
							class="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-bg-surface"
							@click="close()"
						>
							<Icon name="lucide:messages-square" class="size-4 text-text-tertiary" />
							{{ t('components.agentTasks.reviewFocusFlow.openThread') }}
						</NuxtLink>
					</template>
				</PostboxOverflowMenu>
			</template>

			<template
				v-if="
					assist.draftWithAi.value && isAdmin && reply.composerTarget.value && !showClarification
				"
				#peek-actions
			>
				<AnswerPeekDraft :disabled="assist.ask.busy.value" @draft="draftFromPeek" />
			</template>

			<template #conversation="{ layout }">
				<AnswerTeamConversation
					v-if="thread"
					v-model:view="view"
					:messages="messages"
					:follow-ups="followUps"
					:contact="contact"
					:answering-id="reply.target.value?._id ?? null"
					:member-name="memberName"
					:undoing-follow-up-id="undoingFollowUpId"
					@undo-follow-up="undoFollowUp"
				>
					<template #catch-up="{ view: shown, reveal }">
						<CatchUpCard
							v-if="shown === 'summary'"
							:collapsible="layout === 'phone'"
							:catch-up="assist.catchUp.catchUp.value"
							:loading="assist.catchUp.loading.value"
							:messages="catchUpMessages"
							:covered="assist.catchUp.covered.value"
							:can-attach="false"
							@reveal="reveal"
						/>
					</template>
				</AnswerTeamConversation>
				<!-- A failed read is not a missing thread (#721). -->
				<UiQueryBoundary
					v-else-if="threadError"
					:error="threadError"
					@retry="detail.refetchThread"
				/>
				<div v-else-if="threadLoading" class="space-y-3 p-6" aria-hidden="true">
					<UiSkeleton class="h-4 w-1/3" />
					<UiSkeleton class="h-40 w-full rounded-(--radius-card)" />
				</div>
				<p v-else class="p-6 text-sm text-text-secondary" data-testid="answer-team-not-found">
					{{ t('dashboard.inbox.detail.notFound') }}
				</p>
			</template>

			<template #composer>
				<InboxComposeModeTabs
					v-if="isAdmin"
					v-model="composeMode"
					:note-count="threadNotes.liveCount.value"
				/>
				<InboxAnswerNotesPanel
					v-if="isAdmin"
					:active="composeMode === 'note'"
					:notes="threadNotes"
					:is-admin="isAdmin"
				/>
				<!-- v-show, not v-if: switching tabs keeps the reply (and the note) as typed. -->
				<InboxThreadComposer
					v-if="isAdmin && reply.composerTarget.value"
					v-show="composeMode === 'reply'"
					ref="composerRef"
					:key="reply.target.value?._id"
					:target="reply.composerTarget.value"
					:sender-label="reply.senderLabel.value"
					:blocker="reply.blocker.value"
					:notice="reply.notice.value"
					:draft="reply.draft.value"
					:original-draft="reply.originalDraft.value"
					:subject="reply.subject.value"
					:busy="reply.busy.value"
					:held="heldBy !== null"
					:held-by="heldBy"
					:held-reason="holdReason"
					:send-hold="sendHold"
					:status-note="assist.statusNote.value"
					:ask-session="!!assist.ask.session.value"
					@send="onSend"
					@save="(body, subject) => reply.save({ body, subject })"
					@reject="reply.reject.openReject()"
					@typing="composerTyping = $event"
				>
					<template #above-editor="{ composer }">
						<!-- The agent's own questions come first: answering resumes its draft. -->
						<div v-if="showClarification" data-testid="answer-team-clarification">
							<p
								v-if="replyLanguage"
								class="px-3 pt-3 text-xs text-text-tertiary"
								data-testid="answer-team-reply-language"
							>
								{{ t('dashboard.inbox.detail.replyLanguageNote', { language: replyLanguage }) }}
							</p>
							<AskCard
								:questions="clarificationQuestions"
								require-all
								:copy-policy="copyPolicy"
								:submitting="reply.isAnsweringClarification.value"
								:skip-label="t('components.postbox.postboxClarificationCard.answerLater')"
								@answer="onClarificationAnswers"
								@skip="clarificationDeferred = true"
							/>
						</div>
						<template v-else>
							<AnswerTeamReusedAnswers
								v-if="reply.reusedAnswers.value.length > 0"
								:questions="reply.reusedAnswers.value"
							/>
							<template v-if="assist.draftWithAi.value">
								<AskCard
									v-if="assist.ask.phase.value === 'asking' && assist.ask.session.value"
									:questions="assist.ask.session.value.questions"
									:round="assist.ask.session.value.round"
									:copy-policy="copyPolicy"
									:submitting="assist.ask.busy.value"
									@answer="assist.ask.answer($event)"
									@skip="assist.ask.answer($event, true)"
								/>
								<AnswerAiBar
									v-else
									:phase="assist.ask.phase.value"
									:busy="assist.ask.busy.value"
									:has-ai-draft="composer.aiDraft.value !== null"
									:injection-flagged="assist.ask.injectionFlagged.value"
									@draft="assist.ask.start"
									@discard="composer.discardAiDraft()"
								/>
							</template>
						</template>
					</template>
					<template v-if="attachmentsAllowed" #attachments>
						<AnswerTeamAttachments
							:thread-id="threadId"
							:contact-id="contact?._id ?? null"
							:contact-name="reply.senderLabel.value"
							:attachments="files.attachments.value"
							:uploads="files.uploads.value"
							:suggestion="files.suggestion.value"
							:busy="reply.busy.value"
							@upload="files.addFiles"
							@attach-existing="files.attachExisting"
							@remove="files.remove"
							@cancel-upload="files.cancelUpload"
							@retry-upload="files.retryUpload"
						/>
					</template>
					<template v-if="reply.blocker.value === 'update'" #blocked-action>
						<UiButton
							variant="secondary"
							size="sm"
							:loading="reply.isRequestingReply.value"
							@click="reply.requestReply"
						>
							<Icon name="lucide:sparkles" class="size-3.5" />
							{{ t('dashboard.inbox.detail.requestReply') }}
						</UiButton>
					</template>
				</InboxThreadComposer>
				<div
					v-else
					v-show="composeMode === 'reply'"
					class="flex-1 space-y-3 p-4"
					aria-hidden="true"
				>
					<UiSkeleton class="h-4 w-2/3" />
					<UiSkeleton class="h-32 w-full" />
				</div>
			</template>
		</AnswerModeFrame>

		<AnswerTeamRejectModal :reject="reply.reject" @confirm="onConfirmReject" />
	</div>
</template>
