<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'chat',
});

const { t } = useI18n();
const router = useRouter();
const { user } = useAuth();

const roomId = useRouteId<'chatRooms'>('roomId');

const { channels, archivedChannels, dms, isLoading: roomsLoading } = useChatRooms();
// Count only here; the Mentions dialog opens the 50-row feed lazily on demand.
const { count: mentionCount } = useChatMentions();
const {
	room,
	roomLoading,
	messages,
	messagesLoading,
	hasMoreMessages,
	loadMoreMessages,
	atMaxMessages,
	members,
	linkedThread,
	sendMessage,
	editMessage,
	deleteMessage,
	joinChannel,
	leaveRoom,
} = useChatRoom(roomId);

const showCreateChannel = ref(false);
const showNewDm = ref(false);
const showBrowseChannels = ref(false);
const showMentions = ref(false);
const showLinkEmail = ref(false);
const showEditChannel = ref(false);
const showMembers = ref(false);

const { archiveChannel, unarchiveChannel } = useChatActions();
const showArchiveConfirm = ref(false);
const isArchiving = ref(false);

const confirmArchive = async () => {
	isArchiving.value = true;
	try {
		await archiveChannel(roomId.value);
	} finally {
		isArchiving.value = false;
		showArchiveConfirm.value = false;
	}
};

const handleUnarchive = async () => {
	await unarchiveChannel(roomId.value);
};

const currentUserId = computed(() => user.value?.id ?? '');

useHead({
	title: () => {
		const name = room.value?.name;
		return name
			? t('dashboard.chat.detail.pageTitleForRoom', { room: name })
			: t('dashboard.chat.detail.pageTitle');
	},
});

const handleSelectRoom = (id: Id<'chatRooms'>) => {
	router.push(`/dashboard/chat/${id}`);
};

const handleSend = async (text: string, attachmentIds?: Id<'mediaAssets'>[]) => {
	await sendMessage(text, attachmentIds);
};

const handleLeave = async () => {
	await leaveRoom();
	router.push('/dashboard/chat');
};
</script>

<template>
	<div class="flex h-[calc(100vh-4rem)] lg:h-[calc(100vh-4rem-3rem)]">
		<!-- Sidebar -->
		<div class="hidden md:block w-72 flex-shrink-0">
			<ChatSidebar
				:channels="channels"
				:archived-channels="archivedChannels"
				:dms="dms"
				:is-loading="roomsLoading"
				:active-room-id="roomId"
				:mention-count="mentionCount"
				@select="handleSelectRoom"
				@new-channel="showCreateChannel = true"
				@new-dm="showNewDm = true"
				@browse-channels="showBrowseChannels = true"
				@mentions="showMentions = true"
			/>
		</div>

		<!-- Main -->
		<div class="flex-1 flex flex-col min-w-0">
			<!-- Loading shell -->
			<div v-if="roomLoading" class="flex-1 flex items-center justify-center">
				<UiSpinner />
			</div>

			<!-- Not found / no access -->
			<div
				v-else-if="!room"
				class="flex-1 flex flex-col items-center justify-center text-center px-6"
			>
				<Icon name="lucide:lock" class="w-8 h-8 text-text-tertiary mb-3" />
				<h3 class="text-lg font-medium text-text-primary">
					{{ t('dashboard.chat.detail.unavailableTitle') }}
				</h3>
				<p class="text-sm text-text-secondary mt-1">
					{{ t('dashboard.chat.detail.unavailableDescription') }}
				</p>
				<UiButton variant="secondary" class="mt-4 gap-2" @click="router.push('/dashboard/chat')">
					<Icon name="lucide:arrow-left" class="w-4 h-4" />
					{{ t('dashboard.chat.detail.backToChat') }}
				</UiButton>
			</div>

			<!-- Room view -->
			<template v-else>
				<ChatRoomHeader
					:room="room"
					:member-count="members.length"
					@show-members="showMembers = !showMembers"
					@link-email="showLinkEmail = true"
					@edit-channel="showEditChannel = true"
					@archive="showArchiveConfirm = true"
					@unarchive="handleUnarchive"
					@leave="handleLeave"
				/>

				<ChatLinkedEmailPanel v-if="linkedThread" :data="linkedThread" />

				<!-- Public channel browse-not-joined banner -->
				<div
					v-if="room.kind === 'channel' && room.visibility === 'public' && !room.isMember"
					class="px-4 py-3 bg-bg-elevated border-b border-border-subtle flex items-center gap-3"
				>
					<Icon name="lucide:eye" class="w-4 h-4 text-text-tertiary" />
					<p class="text-sm text-text-secondary flex-1">
						{{ t('dashboard.chat.detail.previewNotice') }}
					</p>
					<UiButton size="sm" class="gap-2" @click="joinChannel">
						<Icon name="lucide:user-plus" class="w-4 h-4" />
						{{ t('dashboard.chat.detail.join') }}
					</UiButton>
				</div>

				<div class="flex-1 flex min-h-0">
					<!-- Messages -->
					<div class="flex-1 flex flex-col min-w-0">
						<button
							v-if="!messagesLoading && hasMoreMessages && !atMaxMessages"
							type="button"
							class="mx-auto my-2 px-3 py-1 text-sm link"
							@click="loadMoreMessages"
						>
							{{ t('dashboard.chat.detail.loadEarlier') }}
						</button>
						<ChatMessageList
							v-if="!messagesLoading"
							:messages="messages"
							:current-user-id="currentUserId"
							@edit="(id, text) => editMessage(id, text)"
							@delete="(id) => deleteMessage(id)"
						/>
						<div v-else class="flex-1 flex items-center justify-center">
							<UiSpinner size="md" />
						</div>
						<ChatInput v-if="room.isMember" @send="handleSend" />
					</div>

					<!-- Member panel (right column) -->
					<div
						v-if="showMembers"
						class="hidden lg:block w-72 flex-shrink-0 border-l border-border-subtle bg-bg-elevated"
					>
						<ChatMemberList :room="room" :members="members" :current-user-id="currentUserId" />
					</div>
				</div>
			</template>
		</div>

		<ChatNewChannelDialog
			v-if="showCreateChannel"
			@close="showCreateChannel = false"
			@created="
				(id) => {
					showCreateChannel = false;
					router.push(`/dashboard/chat/${id}`);
				}
			"
		/>
		<ChatNewDmDialog
			v-if="showNewDm"
			@close="showNewDm = false"
			@created="
				(id) => {
					showNewDm = false;
					router.push(`/dashboard/chat/${id}`);
				}
			"
		/>
		<ChatChannelBrowser v-if="showBrowseChannels" @close="showBrowseChannels = false" />
		<ChatMentionsDialog v-if="showMentions" @close="showMentions = false" />
		<ChatLinkEmailDialog
			v-if="showLinkEmail && room"
			:room-id="room._id"
			@close="showLinkEmail = false"
		/>
		<ChatEditChannelDialog
			v-if="showEditChannel && room"
			:room-id="room._id"
			:initial-name="room.name"
			:initial-description="room.description"
			:initial-visibility="room.visibility"
			@close="showEditChannel = false"
			@saved="showEditChannel = false"
		/>
		<UiConfirmationDialog
			:open="showArchiveConfirm"
			variant="warning"
			:title="t('dashboard.chat.detail.archiveConfirm.title')"
			:description="t('dashboard.chat.detail.archiveConfirm.description')"
			:confirm-text="t('dashboard.chat.detail.archiveConfirm.confirm')"
			:is-loading="isArchiving"
			@update:open="(v: boolean) => !v && (showArchiveConfirm = false)"
			@confirm="confirmArchive"
		/>
	</div>
</template>
