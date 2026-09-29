<script setup lang="ts">
/**
 * A message the team sent on a Team inbox thread: the reply that answered a
 * customer's message, or a follow-up written after it. Sits in the timeline
 * under the message it answers, so the thread reads as the conversation it
 * was rather than only the customer's half of it.
 *
 * A follow-up still inside its undo window counts down with an Undo button,
 * using the auto-send bar an approved reply shows. The bar owns the clock and
 * mounts only while the follow-up is scheduled, so nothing ticks for a sent
 * message and the thread page never re-renders for the countdown.
 */
import { formatRelativeTime } from '~/utils/formatters';

type OutboundStatus = 'scheduled' | 'sending' | 'sent' | 'failed';

const props = withDefaults(
	defineProps<{
		/** Who sent it: a teammate's name, "Your team" or "The agent". */
		authorLabel: string;
		body: string;
		/** When it was sent, or written if it has not left yet. */
		at: number;
		status: OutboundStatus;
		/** Epoch ms the follow-up leaves (`scheduled` only); drives the Undo countdown. */
		sendAt?: number;
		errorMessage?: string | null;
		undoing?: boolean;
	}>(),
	{ errorMessage: null, undoing: false }
);

const emit = defineEmits<{ (e: 'undo'): void }>();

const { t, locale } = useI18n();

const STATUS_KEYS: Record<OutboundStatus, string> = {
	scheduled: 'dashboard.inbox.detail.outbound.sending',
	sending: 'dashboard.inbox.detail.outbound.sending',
	sent: 'dashboard.inbox.detail.outbound.sent',
	failed: 'dashboard.inbox.detail.outbound.failed',
};

const absoluteTime = computed(() =>
	new Date(props.at).toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'short' })
);
</script>

<template>
	<section
		class="card ml-6 sm:ml-12"
		data-testid="thread-outbound"
		:aria-label="t('dashboard.inbox.detail.outbound.label', { name: authorLabel })"
	>
		<div class="flex items-center gap-3 mb-4">
			<UiIconBox icon="lucide:send" size="sm" variant="surface" rounded="full" />
			<div class="min-w-0 flex-1">
				<p class="text-text-primary font-medium text-sm truncate">{{ authorLabel }}</p>
				<time
					class="text-xs text-text-tertiary"
					:datetime="new Date(at).toISOString()"
					:title="absoluteTime"
				>
					{{ formatRelativeTime(at) }}
				</time>
			</div>
			<span
				class="shrink-0 text-xs"
				:class="status === 'failed' ? 'text-error' : 'text-text-tertiary'"
				data-testid="thread-outbound-status"
			>
				{{ t(STATUS_KEYS[status]) }}
			</span>
		</div>

		<div class="text-text-secondary text-sm whitespace-pre-wrap">{{ body }}</div>

		<InboxAutoSendCountdown
			v-if="status === 'scheduled' && sendAt !== undefined"
			:send-at="sendAt"
			:busy="undoing"
			label-key="dashboard.inbox.detail.outbound.sendsIn"
			data-testid="thread-outbound-undo"
			@cancel="emit('undo')"
		/>

		<p v-if="status === 'failed'" class="mt-3 text-xs text-error break-words">
			{{ errorMessage || t('dashboard.inbox.detail.outbound.failedFallback') }}
		</p>
	</section>
</template>
