<script setup lang="ts">
/**
 * A reply the team sent the customer, in the team stream (plan §4.3):
 * outgoing, white with an arrow, "Mika → Ana". The text is what actually went
 * out (the Send's snapshot, or the follow-up's own text), and its state stays
 * visible: still sending, failed, or sent.
 *
 * A follow-up still inside its undo window counts down with Undo; the bar
 * mounts only while it waits, so nothing ticks once it left.
 */
import { formatRelativeTime } from '~/utils/formatters';
import type { ReplyEntry } from '~/utils/teamStream';

const props = withDefaults(
	defineProps<{
		entry: ReplyEntry;
		/** "Mika", "The agent" or "Your team". */
		authorLabel: string;
		undoing?: boolean;
	}>(),
	{ undoing: false }
);

const emit = defineEmits<{ undo: [] }>();

const { t, locale } = useI18n();

const absoluteTime = computed(() =>
	new Date(props.entry.at).toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'short' })
);
const heading = computed(() =>
	props.entry.toName ? `${props.authorLabel} → ${props.entry.toName}` : props.authorLabel
);
const isCountingDown = computed(
	() =>
		props.entry.status === 'queued' && props.entry.followUpId && props.entry.sendAt !== undefined
);
</script>

<template>
	<section
		class="rounded-(--radius-card) border border-border-subtle bg-bg-elevated px-4 py-3"
		:aria-label="t('components.team.reply.label', { name: authorLabel })"
		data-testid="team-stream-reply"
		:data-message-id="entry.source?.id"
		:data-status="entry.status"
	>
		<header class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
			<Icon name="lucide:send" class="size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
			<span class="min-w-0 truncate font-medium text-text-primary">{{ heading }}</span>
			<time
				class="shrink-0 text-text-tertiary"
				:datetime="new Date(entry.at).toISOString()"
				:title="absoluteTime"
			>
				{{ formatRelativeTime(entry.at) }}
			</time>
			<span class="shrink-0 text-text-tertiary">· {{ t('components.team.reply.email') }}</span>
			<span
				v-if="entry.status !== 'sent'"
				class="ml-auto shrink-0 rounded-full px-2 py-px text-2xs font-medium"
				:class="
					entry.status === 'failed' ? 'bg-error/10 text-error' : 'bg-bg-surface text-text-secondary'
				"
				data-testid="team-reply-status"
			>
				{{ t(`components.team.reply.status.${entry.status}`) }}
			</span>
		</header>
		<p class="mt-1.5 whitespace-pre-wrap break-words text-sm text-text-secondary">
			{{ entry.body ?? entry.preview }}
		</p>
		<InboxAutoSendCountdown
			v-if="isCountingDown"
			:send-at="entry.sendAt!"
			:busy="undoing"
			label-key="dashboard.inbox.detail.outbound.sendsIn"
			data-testid="team-reply-undo"
			@cancel="emit('undo')"
		/>
		<p v-if="entry.status === 'failed'" class="mt-2 break-words text-xs text-error">
			{{ entry.errorMessage || t('dashboard.inbox.detail.outbound.failedFallback') }}
		</p>
	</section>
</template>
