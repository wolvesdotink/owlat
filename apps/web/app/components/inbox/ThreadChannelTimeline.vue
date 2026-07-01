<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	channelIcon,
	channelLabel,
	channelColor,
	directionIcon,
	directionLabel,
	formatTimelineTime,
	truncateTimelineText,
} from '~/composables/useUnifiedContactTimeline';

const props = defineProps<{
	threadId: Id<'conversationThreads'>;
}>();

// Per-thread cross-channel timeline. The inbound-message column above shows the
// email-processing pipeline (drafts, classification); this surfaces the unified
// `unifiedMessages` stream for the thread — every channel (email/sms/whatsapp/
// chat/generic), in chronological order — via `unifiedMessages.getThreadTimeline`.
const { data: messagesData, isLoading } = useConvexQuery(
	api.unifiedMessages.getThreadTimeline,
	() => ({ threadId: props.threadId, limit: 100 }),
);

const timeline = computed(() => messagesData.value ?? []);
</script>

<template>
	<div class="card">
		<div class="mb-4">
			<h2 class="text-lg font-medium text-text-primary">Cross-channel Timeline</h2>
			<p class="text-text-tertiary text-sm mt-0.5">
				Every message on this thread across all channels.
			</p>
		</div>

		<!-- Loading -->
		<div v-if="isLoading && !timeline.length" class="flex items-center justify-center py-6">
			<UiSpinner size="sm" />
		</div>

		<!-- Empty -->
		<div v-else-if="timeline.length === 0" class="text-center py-6">
			<p class="text-text-tertiary text-sm">No cross-channel messages yet.</p>
		</div>

		<!-- Timeline list -->
		<div v-else class="space-y-1">
			<div
				v-for="(item, index) in timeline"
				:key="item._id"
				class="relative"
			>
				<!-- Timeline connector -->
				<div
					v-if="index < timeline.length - 1"
					class="absolute left-4 top-9 bottom-0 w-px bg-border-subtle"
				/>

				<!-- Timeline item -->
				<div class="flex items-start gap-3 py-2.5">
					<!-- Channel icon -->
					<div class="flex-shrink-0 w-8 h-8 rounded-full bg-bg-surface flex items-center justify-center">
						<Icon :name="channelIcon(item.channel)" class="w-4 h-4" :class="channelColor(item.channel)" />
					</div>

					<!-- Content -->
					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-2 mb-0.5">
							<!-- Direction badge -->
							<span
								:class="[
									'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium',
									item.direction === 'inbound'
										? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400'
										: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400',
								]"
							>
								<Icon :name="directionIcon(item.direction)" class="w-3 h-3" />
								{{ directionLabel(item.direction) }}
							</span>

							<!-- Channel badge -->
							<UiBadge variant="neutral" size="sm">
								{{ channelLabel(item.channel) }}
							</UiBadge>

							<!-- Status -->
							<UiBadge
								v-if="item.status && item.status !== 'received' && item.status !== 'sent'"
								:variant="item.status === 'delivered' || item.status === 'read' ? 'success' : item.status === 'failed' ? 'error' : 'neutral'"
								size="sm"
							>
								{{ item.status }}
							</UiBadge>
						</div>

						<!-- Subject (for email) -->
						<p v-if="item.content.subject" class="text-text-primary text-sm font-medium">
							{{ item.content.subject }}
						</p>

						<!-- Content preview -->
						<p class="text-text-secondary text-sm mt-0.5">
							{{ truncateTimelineText(item.content.text || '') }}
						</p>

						<!-- Time -->
						<p class="text-text-tertiary text-xs mt-1">
							{{ formatTimelineTime(item.createdAt) }}
						</p>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>
