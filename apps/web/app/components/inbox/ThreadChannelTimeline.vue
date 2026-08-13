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
import { useChannelOutbound } from '~/composables/useChannelOutbound';
import type { SendableChannel } from '~/composables/useChannelOutbound';

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

// Per-message reply. Non-email channels used to be outbound-only through the AI
// agent or the contact page's composer, so an agent reading an SMS in the Team
// Inbox had to leave the thread to answer it. Replying here goes through the
// SAME shared send path (`useChannelOutbound`), pinned to this thread and to the
// channel the message arrived on. Email is excluded: it is answered by the draft
// composer above, which carries the MTA send pipeline, identities and threading.
const { isSending, canSendOn, send } = useChannelOutbound();

type TimelineMessage = (typeof timeline.value)[number];

function canReplyTo(item: TimelineMessage): boolean {
	if (item.channel === 'email') return false;
	// A provider send is addressed to the contact, so a row with no contact
	// (a legacy or unlinked message) has nowhere to reply to.
	if (item.channel !== 'chat' && !item.contactId) return false;
	return canSendOn(item.channel);
}

const replyToId = ref<Id<'unifiedMessages'> | null>(null);
const replyText = ref('');

function openReply(item: TimelineMessage) {
	replyToId.value = item._id;
	replyText.value = '';
}

function cancelReply() {
	replyToId.value = null;
	replyText.value = '';
}

async function submitReply(item: TimelineMessage) {
	const sent = await send({
		channel: item.channel as SendableChannel,
		text: replyText.value,
		contactId: item.contactId ?? null,
		threadId: props.threadId,
	});
	if (sent) cancelReply();
}
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
										? 'bg-info-subtle text-info'
										: 'bg-success-subtle text-success',
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

							<!-- Reply on this channel -->
							<button
								v-if="canReplyTo(item) && replyToId !== item._id"
								type="button"
								class="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
								:aria-label="`Reply on ${channelLabel(item.channel)}`"
								@click="openReply(item)"
							>
								<Icon name="lucide:reply" class="w-3.5 h-3.5" />
								Reply
							</button>
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

						<!-- Inline reply composer, scoped to this message's channel -->
						<div
							v-if="replyToId === item._id"
							class="mt-2 rounded-lg border border-border-subtle bg-bg-surface p-2"
						>
							<UiTextarea
								v-model="replyText"
								:rows="2"
								size="sm"
								:placeholder="`Reply on ${channelLabel(item.channel)}…`"
							/>
							<div class="flex items-center justify-end gap-2 mt-2">
								<UiButton variant="secondary" size="sm" :disabled="isSending" @click="cancelReply">
									Cancel
								</UiButton>
								<UiButton
									size="sm"
									:disabled="!replyText.trim() || isSending"
									:loading="isSending"
									@click="submitReply(item)"
								>
									<template #iconLeft>
										<Icon name="lucide:send" class="w-4 h-4" />
									</template>
									Send
								</UiButton>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>
