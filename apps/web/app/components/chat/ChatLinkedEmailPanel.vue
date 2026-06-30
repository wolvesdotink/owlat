<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

interface Thread {
	_id: Id<'conversationThreads'>;
	subject: string;
	contactIdentifier: string;
	status: 'open' | 'waiting' | 'resolved' | 'closed';
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

const isExpanded = ref(false);

const formatTime = (timestamp: number) => {
	return new Date(timestamp).toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	});
};

const statusClass = (status: Thread['status']) => {
	switch (status) {
		case 'open':
			return 'text-brand bg-brand-subtle';
		case 'waiting':
			return 'text-warning bg-warning/10';
		case 'resolved':
			return 'text-success bg-success-subtle';
		case 'closed':
			return 'text-text-tertiary bg-bg-surface';
	}
};
</script>

<template>
	<div class="border-b border-border-subtle bg-brand-subtle/30">
		<div class="px-4 py-3 flex items-center gap-3">
			<Icon name="lucide:mail" class="w-4 h-4 text-brand flex-shrink-0" />
			<div class="flex-1 min-w-0">
				<div class="flex items-center gap-2">
					<span class="text-xs uppercase tracking-wider font-semibold text-brand">Linked email</span>
					<span
						class="text-[10px] px-1.5 py-0.5 rounded-full font-semibold uppercase tracking-wider"
						:class="statusClass(data.thread.status)"
					>
						{{ data.thread.status }}
					</span>
				</div>
				<h3 class="text-sm font-semibold text-text-primary truncate mt-0.5">
					{{ data.thread.subject }}
				</h3>
				<p class="text-xs text-text-tertiary truncate">
					{{ data.thread.contactIdentifier }} · {{ data.thread.messageCount }} message{{ data.thread.messageCount === 1 ? '' : 's' }}
				</p>
			</div>
			<button
				class="text-xs text-text-secondary hover:text-text-primary px-2 py-1 rounded hover:bg-bg-surface transition-colors"
				@click="isExpanded = !isExpanded"
			>
				{{ isExpanded ? 'Collapse' : 'Expand' }}
			</button>
			<NuxtLink
				:to="`/dashboard/inbox/${data.thread._id}`"
				class="text-xs text-brand hover:underline px-2 py-1"
			>
				Open in Inbox
			</NuxtLink>
		</div>

		<div
			v-if="isExpanded"
			class="px-4 pb-3 space-y-2 max-h-72 overflow-y-auto border-t border-border-subtle"
		>
			<div v-if="data.recentMessages.length === 0" class="text-xs text-text-tertiary py-2">
				No inbound messages yet.
			</div>
			<div
				v-for="message in data.recentMessages"
				:key="message._id"
				class="bg-bg-elevated border border-border-subtle rounded p-2.5 text-xs"
			>
				<div class="flex items-center justify-between mb-1">
					<span class="font-medium text-text-primary truncate">{{ message.from }}</span>
					<span class="text-text-tertiary flex-shrink-0">{{ formatTime(message.receivedAt) }}</span>
				</div>
				<p v-if="message.textBody" class="text-text-secondary whitespace-pre-wrap line-clamp-3">
					{{ message.textBody }}
				</p>
			</div>
		</div>
	</div>
</template>
