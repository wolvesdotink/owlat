<script setup lang="ts">
/**
 * "Share in chat…": pick a room you can post in, add a note if you like, and
 * the conversation's link goes there as an ordinary chat message. The body of
 * `ChatLinkEmailDialog` when it is opened from a conversation rather than from
 * a room.
 *
 * Only the link is posted, never the subject or the mail: the room's members
 * may not be able to read the conversation, and the link opens only for those
 * who can (the mailbox or Team Inbox gate decides, as for any other read). The
 * line under the picker says who that is.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { ConversationLinkTarget } from '~/utils/conversationLink';
import { conversationLinkUrl } from '~/composables/useConversationLink';

const props = defineProps<{
	conversation: ConversationLinkTarget;
	/** Who can open the link: the mailbox's owner, its members, or Team Inbox readers. */
	audience: 'personal' | 'shared' | 'team';
}>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const { showToast } = useToast();
const { channels, dms, isLoading } = useChatRooms();

interface RoomChoice {
	id: Id<'chatRooms'>;
	label: string;
	icon: string;
}

// Only rooms a post can land in: a channel you have joined (the send refuses
// anything else) and your DMs. Archived channels are already left out.
const rooms = computed<RoomChoice[]>(() => [
	...channels.value
		.filter((channel) => channel.isMember)
		.map((channel) => ({
			id: channel._id,
			label: `#${channel.displayName}`,
			icon: channel.visibility === 'private' ? 'lucide:lock' : 'lucide:hash',
		})),
	...dms.value.map((dm) => ({ id: dm._id, label: dm.displayName, icon: 'lucide:user' })),
]);

const search = ref('');
const visibleRooms = computed(() => {
	const query = search.value.trim().toLowerCase();
	return query
		? rooms.value.filter((room) => room.label.toLowerCase().includes(query))
		: rooms.value;
});

const selectedId = ref<Id<'chatRooms'> | null>(null);
const note = ref('');
const sending = ref(false);

const { run: sendMessage } = useBackendOperation(api.chat.messages.sendMessage, {
	label: () => t('shared.chat.useChatRoom.sendMessage'),
});

async function share() {
	const room = rooms.value.find((candidate) => candidate.id === selectedId.value);
	if (!room || sending.value) return;
	const url = conversationLinkUrl(props.conversation);
	if (!url) {
		showToast(t('shared.conversationLink.linkUnavailable'), 'error');
		return;
	}
	const text = note.value.trim() ? `${note.value.trim()}\n\n${url}` : url;
	sending.value = true;
	try {
		// A refused send has been toasted by the operation; the dialog stays open
		// with the room and the note so it can be tried again.
		const result = await sendMessage({ roomId: room.id, text });
		if (!result.ok) return;
		showToast(t('components.chat.chatLinkEmailDialog.share.shared', { room: room.label }));
		emit('close');
	} finally {
		sending.value = false;
	}
}
</script>

<template>
	<div class="px-5 py-3 border-b border-border-subtle">
		<input
			v-model="search"
			type="text"
			:placeholder="t('components.chat.chatLinkEmailDialog.share.searchPlaceholder')"
			:aria-label="t('components.chat.chatLinkEmailDialog.share.searchPlaceholder')"
			class="input w-full"
		/>
	</div>

	<div class="flex-1 min-h-0 overflow-y-auto p-2">
		<div v-if="isLoading" class="flex items-center justify-center py-8">
			<UiSpinner size="md" delay />
		</div>
		<div v-else-if="visibleRooms.length === 0" class="text-center py-8 text-text-tertiary text-sm">
			{{ t('components.chat.chatLinkEmailDialog.share.empty') }}
		</div>
		<div
			v-else
			role="group"
			:aria-label="t('components.chat.chatLinkEmailDialog.share.roomsLabel')"
			class="space-y-1"
		>
			<button
				v-for="room in visibleRooms"
				:key="room.id"
				type="button"
				:aria-pressed="room.id === selectedId"
				class="w-full text-left flex items-center gap-3 px-3 py-2 rounded-lg transition-colors"
				:class="room.id === selectedId ? 'bg-brand-subtle' : 'hover:bg-bg-surface'"
				:data-testid="`share-room-${room.id}`"
				@click="selectedId = room.id"
			>
				<Icon :name="room.icon" class="w-4 h-4 text-text-tertiary flex-shrink-0" />
				<span class="flex-1 min-w-0 truncate text-sm text-text-primary">{{ room.label }}</span>
				<Icon v-if="room.id === selectedId" name="lucide:check" class="w-4 h-4 text-brand" />
			</button>
		</div>
	</div>

	<div class="px-5 pt-3 space-y-2 border-t border-border-subtle">
		<textarea
			v-model="note"
			rows="2"
			:placeholder="t('components.chat.chatLinkEmailDialog.share.notePlaceholder')"
			:aria-label="t('components.chat.chatLinkEmailDialog.share.notePlaceholder')"
			class="input w-full resize-none"
		/>
		<p class="text-xs text-text-tertiary" data-testid="share-audience">
			{{ t(`components.chat.chatLinkEmailDialog.share.audience.${audience}`) }}
		</p>
	</div>

	<div class="flex items-center justify-end gap-3 px-5 py-3">
		<UiButton variant="secondary" @click="emit('close')">{{ t('common.cancel') }}</UiButton>
		<UiButton data-testid="share-send" :disabled="!selectedId" :loading="sending" @click="share">
			{{ t('components.chat.chatLinkEmailDialog.share.send') }}
		</UiButton>
	</div>
</template>
