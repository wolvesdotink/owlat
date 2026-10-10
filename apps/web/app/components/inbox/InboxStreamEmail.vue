<script setup lang="ts">
/**
 * A customer's email in the Team Inbox stream (plan §4.3): as written, on the
 * gray customer bubble, with its attachments, and what needs the team's hand
 * on it: another draft waiting, a failed message's Retry, the agent's
 * questions, an auto-send countdown, and (for admins) the agent's working
 * behind one disclosure.
 */
import type { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';
import { formatRelativeTime } from '~/utils/formatters';

type ThreadData = NonNullable<FunctionReturnType<typeof api.inbox.queries.getThread>>;
type ThreadMessage = ThreadData['messages'][number];

const props = defineProps<{
	message: ThreadMessage;
	contact: ThreadData['contact'];
	isAdmin: boolean;
	/** Another message of the thread has a draft waiting here too. */
	hasWaitingDraft: boolean;
	retrying: boolean;
	undoingAutoSend: boolean;
}>();

const emit = defineEmits<{
	answer: [];
	reject: [];
	retry: [];
	'cancel-auto-send': [];
}>();

const { t, locale } = useI18n();

// The sender's name when they are the thread's contact; the address stays beside it.
const senderName = computed(() => {
	const c = props.contact;
	if (!c) return null;
	const m = props.message;
	const isContact = m.contactId === c._id || m.from.toLowerCase() === (c.email ?? '').toLowerCase();
	if (!isContact) return null;
	return `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || null;
});
// The agent's working is only worth a disclosure when there is some.
const hasAgentInsight = computed(() => {
	const m = props.message;
	return Boolean(
		m.classification ||
		m.agentDecision ||
		m.processingStatus === 'failed' ||
		m.processingStatus === 'quarantined'
	);
});
const absoluteTime = computed(() =>
	new Date(props.message._creationTime).toLocaleString(locale.value, {
		dateStyle: 'medium',
		timeStyle: 'short',
	})
);
</script>

<template>
	<article
		class="rounded-(--radius-card) bg-bg-surface px-4 py-3 sm:px-5 sm:py-4"
		:data-message-id="message._id"
		data-testid="team-stream-email"
	>
		<header class="mb-3 flex items-center gap-2.5">
			<UiAvatar :name="senderName ?? message.from" deterministic-color size="sm" />
			<div class="min-w-0">
				<p class="truncate text-sm">
					<template v-if="senderName">
						<span class="font-medium text-text-primary">{{ senderName }}</span>
						<span class="ml-1.5 text-xs text-text-tertiary">{{ message.from }}</span>
					</template>
					<span v-else class="font-medium text-text-primary">{{ message.from }}</span>
				</p>
				<p class="text-xs text-text-tertiary">
					<time :datetime="new Date(message._creationTime).toISOString()" :title="absoluteTime">
						{{ formatRelativeTime(message._creationTime) }}
					</time>
					· {{ t('components.team.reply.email') }}
				</p>
			</div>
		</header>

		<!-- This message also sits in someone's personal mailbox (idea 31). -->
		<InboxCrossSurfaceStrip :inbound-message-id="message._id" class="mb-3" />
		<InboxMessageBody :message="message" />
		<InboxMessageAttachments :message="message" />

		<div
			v-if="isAdmin && hasWaitingDraft"
			class="mt-4 flex flex-wrap items-center gap-2 rounded-lg bg-warning/10 p-3"
			data-testid="thread-waiting-draft"
		>
			<p class="flex-1 text-xs text-text-secondary">
				{{ t('dashboard.inbox.detail.waitingDraft.notice') }}
			</p>
			<UiButton variant="secondary" size="sm" @click="emit('answer')">
				<Icon name="lucide:reply" class="w-3.5 h-3.5" />
				{{ t('dashboard.inbox.detail.waitingDraft.answer') }}
			</UiButton>
			<UiButton variant="ghost" size="sm" @click="emit('reject')">
				{{ t('dashboard.inbox.detail.composer.rejectDraft') }}
			</UiButton>
		</div>

		<InboxFailedNotice
			v-if="message.processingStatus === 'failed'"
			:message="message"
			:retrying="retrying"
			@retry="emit('retry')"
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
			<UiButton size="sm" @click="emit('answer')">
				<Icon name="lucide:message-circle-question" class="w-3.5 h-3.5" />
				{{ t('dashboard.inbox.detail.answerInReply') }}
			</UiButton>
		</div>

		<InboxAutoSendCountdown
			v-if="isAdmin && message.pendingAutoSend"
			:send-at="message.pendingAutoSend.sendAt"
			:busy="undoingAutoSend"
			@cancel="emit('cancel-auto-send')"
		/>

		<InboxAgentInsight
			v-if="isAdmin && hasAgentInsight"
			:inbound-message-id="message._id"
			:classification="message.classification ?? null"
			:decision-reason="message.agentDecision?.reason ?? null"
		/>
	</article>
</template>
