<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

defineProps<{
	subject?: string;
	messageCount: number;
	messageId: Id<'mailMessages'>;
	thread?: {
		_id: string;
		followUp?: { messageId: string; remindAt: number; dueAt?: number; waitingOn?: string };
	} | null;
	latestOutboundId?: string;
	labelIds: string[];
	labels: Map<string, { _id: string; name: string; color?: string }>;
}>();
</script>

<template>
	<header class="pbx-reader-header mb-4">
		<h1 class="text-2xl font-semibold text-text-primary">
			{{ subject || '(no subject)' }}
			<span
				v-if="messageCount > 1"
				class="ml-1 text-base font-normal text-text-tertiary align-middle"
			>
				({{ messageCount }})
			</span>
		</h1>
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
