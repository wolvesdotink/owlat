<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	subject?: string;
	messageCount: number;
	messageId: Id<'mailMessages'>;
	thread?: {
		_id: string;
		followUp?: { messageId: string; remindAt: number; dueAt?: number; waitingOn?: string };
		/** Muted conversation (mail/mute.ts) — new mail skips the inbox. */
		mutedAt?: number;
		/**
		 * Armed with "notify me when they reply" (mail/threadAlerts.ts) — a new
		 * message here toasts through quiet hours and the people-only scope.
		 */
		notifyOnReplyAt?: number;
		/** Just came back from snooze (mail/snooze.ts sweep); cleared on open. */
		snoozeReturnedAt?: number;
	} | null;
	latestOutboundId?: string;
	labelIds: string[];
	labels: Map<string, { _id: string; name: string; color?: string }>;
	/** Offer the explicit mark-read button (markReadPolicy 'manual', unread thread). */
	showMarkRead?: boolean;
	/** True while the mark-read mutation is in flight. */
	markingRead?: boolean;
}>();

const emit = defineEmits<{
	(e: 'unmute'): void;
	(e: 'mark-read'): void;
	(e: 'stop-alert'): void;
}>();

const { t } = useI18n();

const isMuted = computed(() => props.thread?.mutedAt != null);
const isAlerted = computed(() => props.thread?.notifyOnReplyAt != null);
const cameBackFromSnooze = computed(() => props.thread?.snoozeReturnedAt != null);
</script>

<template>
	<header class="pbx-reader-header mb-4">
		<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
			{{ subject || t('components.postbox.postboxThreadHeader.noSubject') }}
			<span
				v-if="messageCount > 1"
				class="ml-1 text-base font-normal text-text-tertiary align-middle"
			>
				({{ messageCount }})
			</span>
		</h1>
		<!-- Thread state chips: why this conversation is quiet (muted) or loud
		     (alerting on reply), and the one-shot "you asked for this back" cue
		     after a snooze returned. Both toggles are also the way back out. -->
		<div
			v-if="isMuted || isAlerted || cameBackFromSnooze || showMarkRead"
			class="mt-2 flex flex-wrap gap-2"
		>
			<button
				v-if="isAlerted"
				type="button"
				class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs border border-border-subtle text-brand hover:bg-bg-surface"
				:title="t('components.postbox.postboxThreadHeader.alertedHint')"
				@click="emit('stop-alert')"
			>
				<Icon name="lucide:bell-ring" class="w-3.5 h-3.5" />
				{{ t('components.postbox.postboxThreadHeader.alerted') }}
			</button>
			<button
				v-if="isMuted"
				type="button"
				class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs border border-border-subtle text-text-tertiary hover:text-text-primary"
				:title="t('components.postbox.postboxThreadHeader.unmuteHint')"
				@click="emit('unmute')"
			>
				<Icon name="lucide:bell-off" class="w-3.5 h-3.5" />
				{{ t('components.postbox.postboxThreadHeader.muted') }}
			</button>
			<span
				v-if="cameBackFromSnooze"
				class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs border border-border-subtle text-text-tertiary"
			>
				<Icon name="lucide:undo-2" class="w-3.5 h-3.5" />
				{{ t('components.postbox.postboxThreadHeader.backFromSnooze') }}
			</span>
			<button
				v-if="showMarkRead"
				type="button"
				class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs border border-border-subtle text-brand hover:bg-bg-surface disabled:opacity-60"
				:disabled="markingRead"
				@click="emit('mark-read')"
			>
				<Icon name="lucide:mail-open" class="w-3.5 h-3.5" />
				{{ t('components.postbox.postboxThreadHeader.markRead') }}
			</button>
		</div>
		<PostboxFollowUpChip
			v-if="thread"
			:thread="thread"
			:latest-outbound-id="latestOutboundId"
			class="mt-2"
		/>
		<PostboxTeamReplyBadge :message-id="messageId" class="mt-2" />
		<div v-if="labelIds.length > 0" class="mt-2 flex flex-wrap items-center gap-1.5">
			<span
				v-for="labelId in labelIds"
				:key="labelId"
				class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs"
				:style="{
					backgroundColor: (labels.get(labelId)?.color || '#6b7280') + '20',
					color: labels.get(labelId)?.color || '#6b7280',
				}"
			>
				<span
					class="w-1.5 h-1.5 rounded-full"
					:style="{ backgroundColor: labels.get(labelId)?.color || '#6b7280' }"
				/>
				{{ labels.get(labelId)?.name }}
			</span>
		</div>
	</header>
</template>
