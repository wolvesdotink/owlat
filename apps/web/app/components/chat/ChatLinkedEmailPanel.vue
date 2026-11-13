<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { formatDateTime } from '~/utils/formatters';
import { MailIcon } from '@coolicons/vue';

interface Thread {
	_id: Id<'conversationThreads'>;
	subject: string;
	contactIdentifier: string;
	status: 'open' | 'waiting' | 'resolved' | 'closed';
	latestDraftStatus?: 'pending' | 'approved' | 'rejected' | 'sent';
	snoozedUntil?: number;
	snoozeReturnedAt?: number;
	messageCount: number;
	lastMessageAt: number;
	assignedTo?: string;
}

interface InboundMessage {
	_id: Id<'inboundMessages'>;
	from: string;
	to: string;
	subject: string;
	textBody: string | null;
	receivedAt: number;
	processingStatus: string;
}

interface Props {
	data: {
		thread: Thread;
		recentMessages: InboundMessage[];
	};
}

defineProps<Props>();

const { t } = useI18n();

const isExpanded = ref(false);
const recentId = useId();
</script>

<template>
	<div class="border-b border-border-subtle bg-bg-surface">
		<div class="px-4 py-3 flex items-center gap-3">
			<MailIcon class="w-4 h-4 text-brand flex-shrink-0" />
			<div class="flex-1 min-w-0">
				<div class="flex items-center gap-2">
					<span class="text-2xs uppercase tracking-wider font-semibold text-text-tertiary">{{
						t('components.chat.chatLinkedEmailPanel.heading')
					}}</span>
					<InboxStatusChip
						:status="data.thread.status"
						:latest-draft-status="data.thread.latestDraftStatus"
						:snoozed-until="data.thread.snoozedUntil"
						:snooze-returned-at="data.thread.snoozeReturnedAt"
					/>
				</div>
				<h3 class="text-sm font-semibold text-text-primary truncate mt-0.5">
					{{ data.thread.subject }}
				</h3>
				<p class="text-xs text-text-tertiary truncate">
					{{ data.thread.contactIdentifier }} ·
					{{
						t(
							'components.chat.chatLinkedEmailPanel.messageCount',
							{ count: data.thread.messageCount },
							data.thread.messageCount
						)
					}}
				</p>
			</div>
			<button
				type="button"
				class="text-xs text-text-secondary hover:text-text-primary px-2 py-1 pointer-coarse:min-h-11 rounded hover:bg-bg-elevated transition-colors"
				:aria-expanded="isExpanded"
				:aria-controls="recentId"
				@click="isExpanded = !isExpanded"
			>
				{{
					isExpanded
						? t('components.chat.chatLinkedEmailPanel.collapse')
						: t('components.chat.chatLinkedEmailPanel.expand')
				}}
			</button>
			<NuxtLink
				:to="`/dashboard/inbox/${data.thread._id}`"
				class="text-xs text-brand hover:underline px-2 py-1 pointer-coarse:min-h-11 pointer-coarse:inline-flex pointer-coarse:items-center"
			>
				{{ t('components.chat.chatLinkedEmailPanel.openInInbox') }}
			</NuxtLink>
		</div>

		<div
			v-if="isExpanded"
			:id="recentId"
			class="px-4 pb-3 space-y-2 max-h-72 overflow-y-auto border-t border-border-subtle"
		>
			<div v-if="data.recentMessages.length === 0" class="text-xs text-text-tertiary py-2">
				{{ t('components.chat.chatLinkedEmailPanel.noMessages') }}
			</div>
			<div
				v-for="message in data.recentMessages"
				:key="message._id"
				class="bg-bg-elevated border border-border-subtle rounded p-2.5 text-xs"
			>
				<div class="flex items-center justify-between mb-1">
					<span class="font-medium text-text-primary truncate">{{ message.from }}</span>
					<span class="text-text-tertiary flex-shrink-0">{{
						formatDateTime(message.receivedAt)
					}}</span>
				</div>
				<p v-if="message.textBody" class="text-text-secondary whitespace-pre-wrap line-clamp-3">
					{{ message.textBody }}
				</p>
			</div>
		</div>
	</div>
</template>
