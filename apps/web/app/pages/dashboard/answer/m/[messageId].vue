<script setup lang="ts">
/**
 * Answer mode for Postbox mail: one reply, the whole screen (plan §02).
 *
 *   /dashboard/answer/m/<mailMessageId>?kind=reply|replyAll|forward&draft=<id>
 *
 * The conversation on the left, the composer on the right. The URL is the
 * state: `?draft=` resumes a draft, otherwise `?kind=` (or the person's default
 * reply) opens a fresh one, and the composer's first autosave writes the new
 * draft id back into the URL (replace), so a reload lands in the same place.
 *
 * Leaving (Esc, "← Inbox", or a send) goes back to the page it came from; the
 * draft stays saved, and a draft with something in it is offered back on the
 * list ("Draft to Jonas saved · Resume").
 *
 * Keys: Esc leaves (inside the editor the first Esc only blurs it), `t`
 * toggles Summary / Full conversation, Cmd/Ctrl+J focuses "Draft with AI"
 * instead of opening the Assistant.
 */
import type { ComputedRef } from 'vue';
import type { ReplyRisk } from '~/utils/senderAuth';
import { deriveReplyRisk, senderRiskInputOf } from '~/utils/senderAuth';
import { extractEmailAddress } from '~/utils/emailAddress';
import { recipientLabel } from '~/utils/recipientHints';
import { isDialogOpen } from '~/utils/dialogOpen';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import { isChordPending } from '~/utils/shortcutScope';
import { parseAnswerKind, singleQueryValue } from '~/utils/answerMode';
import {
	useAnswerAiFocus,
	useAnswerLeftDraft,
	useAnswerModeNav,
} from '~/composables/useAnswerMode';
import { useAnswerModeSession, type AnswerModeMessage } from '~/composables/useAnswerModeSession';
import { useAnswerModeAssist } from '~/composables/useAnswerModeAssist';
import type { AnswerComposerApi } from '~/composables/postbox/usePostboxComposerAnswerApi';
import type { PostboxReaderMessage } from '~/components/postbox/PostboxThreadReader.vue';
import type { AnswerConversationView } from '~/components/answer/AnswerConversation.vue';
import CatchUpCard from '~/components/answer/CatchUpCard.vue';
import AnswerAiBar from '~/components/answer/AnswerAiBar.vue';
import AskCard from '~/components/answer/AskCard.vue';

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
	answerMode: true,
});

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const messageId = computed(() => singleQueryValue(route.params['messageId']) ?? '');
// The URL as the page opened: a draft id the composer writes in later must not
// rebuild the session under it.
const openedDraftId = singleQueryValue(route.query['draft']);
const openedKind = parseAnswerKind(route.query['kind']);

const message = usePostboxActiveMessage<PostboxReaderMessage>({
	activeMessageId: () => messageId.value,
	listRows: () => [],
}) as ComputedRef<PostboxReaderMessage | undefined>;

useHead({ title: () => message.value?.subject || t('dashboard.answer.mode.pageTitle') });

// ── The reply guard, for links that never passed through the reader ──────────
const { isEnabled: isFeatureEnabled } = useFeatureFlag();
const replyGuardEl = ref<{
	guard: (threadId: string, risk: ReplyRisk | null, to: string, run: () => void) => void;
} | null>(null);
// A message already in the client cache arrives during setup, before the guard
// is mounted: its check waits for the mount instead of being skipped.
let deferredGuard: (() => void) | null = null;
onMounted(() => {
	deferredGuard?.();
	deferredGuard = null;
});
function guardReply(msg: AnswerModeMessage, proceed: () => void) {
	if (!replyGuardEl.value) {
		deferredGuard = () => guardReply(msg, proceed);
		return;
	}
	const risk = isFeatureEnabled('senderAuthBadges')
		? deriveReplyRisk(senderRiskInputOf(msg as PostboxReaderMessage))
		: null;
	replyGuardEl.value.guard(
		msg.threadId ?? msg._id,
		risk,
		extractEmailAddress(msg.fromAddress),
		proceed
	);
}

const { seed, kind } = useAnswerModeSession({
	message: () => message.value,
	draftId: openedDraftId,
	kind: openedKind,
	guard: guardReply,
});

// ── Top bar ──────────────────────────────────────────────────────────────────
const answerNav = useAnswerModeNav();
const backLabel = computed(() => {
	const path = answerNav.returnPath.value;
	if (path.startsWith('/dashboard/postbox')) return t('components.answer.mode.backTo.inbox');
	if (path.startsWith('/dashboard/answer')) return t('components.answer.mode.backTo.queue');
	if (path === '/dashboard' || path.startsWith('/dashboard?'))
		return t('components.answer.mode.backTo.workbench');
	return t('components.answer.mode.backTo.previous');
});
const messageCount = ref<number | undefined>(undefined);
const counterpart = computed(() => {
	const m = message.value;
	return m ? m.fromName || m.fromAddress : '';
});
const { byId: inboxById } = useInboxes();
const inbox = computed(() => {
	const id = message.value?.mailboxId;
	return id ? (inboxById.value.get(id as never) ?? null) : null;
});

const tab = ref<'conversation' | 'reply'>('conversation');
const view = ref<AnswerConversationView>('summary');

// ── The composer and the URL ────────────────────────────────────────────────
const composerRef = ref<{
	focusBody: () => void;
	flush: () => Promise<string | null>;
	snapshot: () => { draftId: string | null; toAddresses: string[]; hasContent: boolean };
	answer: AnswerComposerApi;
} | null>(null);
// One composer per message (and per resumed draft): writing the new draft id
// into the URL must not remount the editor under the person typing.
const composerKey = computed(() => `${messageId.value}:${openedDraftId ?? 'new'}`);

const draftId = ref<string | null>(openedDraftId);

function onDraftId(id: string) {
	draftId.value = id;
	if (route.query['draft'] === id) return;
	void router.replace({
		query: { ...route.query, ...(kind.value ? { kind: kind.value } : {}), draft: id },
	});
}

// ── Catch-up, "Draft with AI" and thread files (plan §03 to §06) ────────────
const assist = useAnswerModeAssist({
	message: () => message.value,
	composer: () => composerRef.value?.answer ?? null,
	draftId: () => draftId.value,
	freshReply: () => !openedDraftId && kind.value !== 'forward',
	messageCount: () => messageCount.value,
	view,
});
const { catchUp, ask } = assist;

const leftDraft = useAnswerLeftDraft();
// Resuming the draft the list offered back: the offer is taken.
if (openedDraftId && leftDraft.left.value?.draftId === openedDraftId) leftDraft.clear();

/**
 * Back to where the reply started. What was typed is saved first (the flush
 * creates the row if the debounce had not yet), and a draft with something in
 * it is offered back on the list. Leaving does not wait for the save.
 */
function leave() {
	const composer = composerRef.value;
	const msg = message.value;
	const snapshot = composer?.snapshot();
	if (composer && msg && snapshot?.hasContent) {
		const recipient = recipientLabel(snapshot.toAddresses[0] ?? msg.fromAddress);
		void composer.flush().then((draftId) => {
			if (!draftId) return;
			leftDraft.set({
				draftId: draftId as never,
				messageId: msg._id,
				mailboxId: msg.mailboxId,
				kind: kind.value,
				recipient,
			});
		});
	}
	answerNav.leave();
}

function onSent() {
	leftDraft.clear();
	answerNav.leave();
}

function onDiscarded() {
	leftDraft.clear();
	answerNav.leave();
}

/** Esc inside the composer: the first one lets go of the editor. */
function onComposerEsc() {
	const active = document.activeElement;
	if (active instanceof HTMLElement) active.blur();
}

// ── Keys ────────────────────────────────────────────────────────────────────
const aiFocus = useAnswerAiFocus();

function onKeydown(event: KeyboardEvent) {
	if (event.defaultPrevented || event.isComposing) return;
	const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
	if (event.key === 'Escape') {
		if (isDialogOpen()) return;
		event.preventDefault();
		const active = document.activeElement;
		if (isEditableTarget(active) && active instanceof HTMLElement) active.blur();
		else leave();
		return;
	}
	if (
		plain &&
		(event.key === 't' || event.key === 'T') &&
		!event.shiftKey &&
		!isEditableTarget(event.target) &&
		!isChordPending() &&
		!isDialogOpen()
	) {
		event.preventDefault();
		view.value = view.value === 'summary' ? 'full' : 'summary';
	}
}

/** Cmd/Ctrl+J, taken before the shell's Assistant chord sees it. */
function onChordCapture(event: KeyboardEvent) {
	if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
	if (event.key.toLowerCase() !== 'j') return;
	event.preventDefault();
	event.stopPropagation();
	tab.value = 'reply';
	if (!aiFocus.request()) composerRef.value?.focusBody();
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
			:subject="message?.subject ?? ''"
			:message-count="messageCount"
			:counterpart="counterpart"
			@back="leave"
		>
			<template #identity>
				<span
					v-if="inbox"
					class="flex min-w-0 items-center gap-1.5 text-xs text-text-secondary"
					data-testid="answer-identity"
				>
					<InboxChip :name="inbox.name" :slot="inbox.slot" />
					<span class="truncate">
						{{ t('components.answer.band.answeringAs', { name: inbox.name }) }}
						<span class="text-text-tertiary">· {{ inbox.address }}</span>
					</span>
				</span>
			</template>
			<template #menu>
				<PostboxOverflowMenu :label="t('components.answer.mode.more')" align="right">
					<template #default="{ close }">
						<NuxtLink
							:to="`/dashboard/postbox/inbox/${messageId}`"
							role="menuitem"
							class="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-bg-surface"
							@click="close()"
						>
							<Icon name="lucide:mail-open" class="size-4 text-text-tertiary" />
							{{ t('components.answer.mode.openInPostbox') }}
						</NuxtLink>
					</template>
				</PostboxOverflowMenu>
			</template>

			<template #conversation>
				<AnswerConversation
					v-if="message"
					v-model:view="view"
					:message="message"
					@count="messageCount = $event"
				>
					<template #catch-up="{ view: shown, messages, reveal }">
						<CatchUpCard
							v-if="shown === 'summary'"
							:catch-up="catchUp.catchUp.value"
							:loading="catchUp.loading.value"
							:messages="messages"
							:covered="catchUp.covered.value"
							:attaching="assist.attaching.value"
							:can-attach="!!seed"
							@reveal="reveal"
							@attach="assist.attachThreadFile"
						/>
					</template>
				</AnswerConversation>
				<PostboxReaderSkeleton v-else />
			</template>

			<template #composer>
				<PostboxComposer
					v-if="seed"
					ref="composerRef"
					:key="composerKey"
					class="min-h-0 flex-1"
					frame="answer"
					:seed="seed"
					:reply-all-recipients="seed.replyAllRecipients"
					:status-note="assist.statusNote.value"
					@draft-id="onDraftId"
					@sent="onSent"
					@discarded="onDiscarded"
					@minimize="onComposerEsc"
					@drop="assist.onComposerDrop"
				>
					<template v-if="assist.aiEnabled.value" #above-editor="{ composer }">
						<AskCard
							v-if="ask.phase.value === 'asking' && ask.session.value"
							:questions="ask.session.value.questions"
							:round="ask.session.value.round"
							:submitting="ask.busy.value"
							:mailbox-id="seed.mailboxId"
							:resolve-thread-file="assist.resolveThreadFile"
							@answer="ask.answer($event)"
							@skip="ask.answer($event, true)"
						/>
						<AnswerAiBar
							v-else
							:phase="ask.phase.value"
							:busy="ask.busy.value"
							:has-ai-draft="composer.aiDraft.value !== null"
							:injection-flagged="ask.injectionFlagged.value"
							@draft="ask.start"
							@discard="composer.discardAiDraft()"
						/>
					</template>
				</PostboxComposer>
				<div v-else class="flex-1 space-y-3 p-4" aria-hidden="true">
					<UiSkeleton class="h-4 w-2/3" />
					<UiSkeleton class="h-32 w-full" />
				</div>
			</template>
		</AnswerModeFrame>

		<PostboxReplyGuard ref="replyGuardEl" @cancel="leave" />
	</div>
</template>
