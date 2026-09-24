<script setup lang="ts">
/**
 * A message the team sent on a Team inbox thread: the reply that answered a
 * customer's message, or a follow-up written after it. Sits in the timeline
 * under the message it answers, so the thread reads as the conversation it
 * was rather than only the customer's half of it.
 *
 * A follow-up still inside its undo window counts down with an Undo button,
 * like the auto-send bar on an approved reply.
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
		/** Seconds left in the undo window (`scheduled` only). */
		secondsLeft?: number;
		errorMessage?: string | null;
		undoing?: boolean;
	}>(),
	{ secondsLeft: 0, errorMessage: null, undoing: false }
);

const emit = defineEmits<{ (e: 'undo'): void }>();

const { t, locale } = useI18n();

const STATUS_KEYS: Record<OutboundStatus, string> = {
	scheduled: 'dashboard.inbox.detail.outbound.sending',
	sending: 'dashboard.inbox.detail.outbound.sending',
	sent: 'dashboard.inbox.detail.outbound.sent',
	failed: 'dashboard.inbox.detail.outbound.failed',
};

const canUndo = computed(() => props.status === 'scheduled' && props.secondsLeft > 0);

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

		<div
			v-if="canUndo"
			class="mt-4 flex items-center justify-between gap-3 rounded-lg border border-brand/20 bg-brand-subtle/30 p-3"
			data-testid="thread-outbound-undo"
		>
			<div class="flex items-center gap-2 text-sm text-text-primary">
				<Icon name="lucide:send" class="h-4 w-4 text-brand" />
				{{ t('dashboard.inbox.detail.outbound.sendsIn', { seconds: secondsLeft }) }}
			</div>
			<UiButton variant="secondary" size="sm" :loading="undoing" @click="emit('undo')">
				{{ t('dashboard.inbox.detail.undo') }}
			</UiButton>
		</div>

		<p v-if="status === 'failed'" class="mt-3 text-xs text-error break-words">
			{{ errorMessage || t('dashboard.inbox.detail.outbound.failedFallback') }}
		</p>
	</section>
</template>
