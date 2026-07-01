<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

/**
 * Mentions inbox: the unread-@-mention feed. Surfaces
 * `chat.mentions.listMyUnreadMentions` (room name, message preview, time) and
 * lets the user jump straight to the mentioning room. Opening a mention marks
 * it read via `chat.mentions.markMentionRead` and navigates there; the room's
 * own `markRead` then clears any remaining unread mentions for that room.
 */
const emit = defineEmits<{ close: [] }>();

const router = useRouter();
// withList=true: this panel is the one place that actually wants the 50-row
// feed, so the composable's lazy `listMyUnreadMentions` subscription opens here.
const { mentions, mentionsLoading, markMentionRead } = useChatMentions(() => true);

const handleOpen = async (mention: {
	_id: Id<'chatMentions'>;
	roomId: Id<'chatRooms'>;
}) => {
	// Mark this single mention read first so the badge updates immediately, then
	// navigate; the room open will also clear the rest for that room.
	await markMentionRead(mention._id);
	router.push(`/dashboard/chat/${mention.roomId}`);
	emit('close');
};
</script>

<template>
	<ChatDialogShell title="Mentions" size="lg" @close="emit('close')">
		<div class="flex-1 overflow-y-auto p-3">
			<div v-if="mentionsLoading" class="flex items-center justify-center py-8">
				<UiSpinner size="md" />
			</div>
			<div
				v-else-if="mentions.length === 0"
				class="flex flex-col items-center justify-center py-10 text-center"
			>
				<div
					class="w-12 h-12 rounded-full bg-bg-surface border border-border-subtle flex items-center justify-center mb-3"
				>
					<Icon name="lucide:at-sign" class="w-5 h-5 text-text-tertiary" />
				</div>
				<p class="text-sm font-medium text-text-primary">You're all caught up</p>
				<p class="text-xs text-text-tertiary mt-1">No unread mentions.</p>
			</div>
			<div v-else class="space-y-1">
				<button
					v-for="mention in mentions"
					:key="mention._id"
					class="w-full flex items-start gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-bg-surface transition-colors"
					@click="handleOpen(mention)"
				>
					<Icon
						:name="mention.roomKind === 'dm' ? 'lucide:message-square' : 'lucide:hash'"
						class="w-4 h-4 text-text-tertiary flex-shrink-0 mt-0.5"
					/>
					<div class="flex-1 min-w-0">
						<div class="flex items-baseline gap-2">
							<span class="text-sm font-medium text-text-primary truncate">
								{{ mention.roomName }}
							</span>
							<span class="text-[11px] text-text-tertiary flex-shrink-0">
								{{ formatCompactRelativeTime(mention.createdAt) }}
							</span>
						</div>
						<p class="text-xs text-text-secondary truncate mt-0.5">
							{{ mention.messagePreview }}
						</p>
					</div>
				</button>
			</div>
		</div>
	</ChatDialogShell>
</template>
