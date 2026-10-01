<script setup lang="ts">
// The rail, its drawer and the new-channel / new-DM / browse / mentions
// dialogs live in the parent route (pages/dashboard/chat.vue); this page is
// the room's main column and its room-only dialogs.
definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'chat',
});

const { t } = useI18n();
const router = useRouter();
const { user } = useAuth();

const roomId = useRouteId<'chatRooms'>('roomId');

const { railOpen, openRail } = useChatShell();
const {
	room,
	roomLoading,
	roomError,
	refetchRoom,
	messages,
	messagesLoading,
	messagesError,
	refetchMessages,
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

const handleLeave = async () => {
	await leaveRoom();
	router.push('/dashboard/chat');
};
</script>

<template>
	<div class="flex-1 flex flex-col min-w-0">
		<!-- Back to the room list. Below md the list IS the drawer — there is no
		     separate list route to navigate to — so this opens it. 44px tall for
		     the thumb, which is also the bar's height; the negative inline margin
		     keeps the icon optically aligned with the content below. -->
		<div class="md:hidden px-3 border-b border-border-subtle">
			<button
				type="button"
				class="-mx-2 h-11 flex items-center gap-1.5 px-2 rounded text-text-secondary hover:text-text-primary hover:bg-bg-surface transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/40"
				aria-controls="chat-rail"
				:aria-expanded="railOpen"
				@click="openRail"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				<span class="text-sm">{{ t('dashboard.chat.detail.backToConversations') }}</span>
			</button>
		</div>

		<!-- A failed read is not a room you cannot reach (#721). -->
		<div v-if="roomError" class="flex-1 flex items-center justify-center">
			<UiQueryBoundary :error="roomError" @retry="refetchRoom" />
		</div>

		<!-- Loading shell -->
		<ChatRoomSkeleton v-else-if="roomLoading" />

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
					<div v-if="messagesError" class="flex-1 flex items-center justify-center">
						<UiQueryBoundary :error="messagesError" @retry="refetchMessages" />
					</div>
					<ChatMessageList
						v-else-if="!messagesLoading"
						:messages="messages"
						:current-user-id="currentUserId"
						@edit="(id, text) => editMessage(id, text)"
						@delete="(id) => deleteMessage(id)"
					/>
					<ChatRoomSkeleton v-else :header="false" />
					<ChatInput v-if="room.isMember" :send="sendMessage" />
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
