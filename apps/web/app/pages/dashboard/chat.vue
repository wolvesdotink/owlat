<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

/**
 * Chat shell: the parent route of `chat/index.vue` (empty state) and
 * `chat/[roomId].vue` (a room). It owns the rail, its subscriptions and the
 * dialogs both children reach, so moving from the empty state to a room, or
 * between rooms, swaps only the main column and never remounts the sidebar.
 * Children open the rail and dialogs through `useChatShell()`.
 */
definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'chat',
});

const { t } = useI18n();
const router = useRouter();

// Undefined on the empty state, the room id under `[roomId]`.
const routeRoomId = useRouteId<'chatRooms'>('roomId');
const activeRoomId = computed(() => routeRoomId.value || undefined);

const { channels, archivedChannels, dms, isLoading } = useChatRooms();
// Count only here; the Mentions dialog opens the 50-row feed lazily on demand.
const { count: mentionCount } = useChatMentions();

const showCreateChannel = ref(false);
const showNewDm = ref(false);
const showBrowseChannels = ref(false);
const showMentions = ref(false);

// Below md the rail is an off-canvas drawer (see UiRailDrawer) rather than a
// column, so the conversation list and its create actions stay reachable on a
// phone instead of being `hidden md:block`-ed away. It also keeps a deep link
// straight into a room from being a dead end: the drawer is the way back to
// the list of rooms.
const railOpen = ref(false);
watch(activeRoomId, () => {
	railOpen.value = false;
});

const handleSelectRoom = (id: Id<'chatRooms'>) => {
	railOpen.value = false;
	router.push(`/dashboard/chat/${id}`);
};

const openRoom = (id: Id<'chatRooms'>) => {
	router.push(`/dashboard/chat/${id}`);
};

provideChatShell({
	railOpen: readonly(railOpen),
	openRail: () => {
		railOpen.value = true;
	},
	openCreateChannel: () => {
		showCreateChannel.value = true;
	},
	openBrowseChannels: () => {
		showBrowseChannels.value = true;
	},
});
</script>

<template>
	<!-- Below lg the chrome around this pane is 4rem of header bar, 2.25rem of
	     breadcrumb strip and the 4rem the tab bar reserves at the bottom of
	     #main-content, plus both safe areas — subtract all of it, or the page
	     itself scrolls and the composer loads under the fold. -->
	<div
		class="flex h-[calc(100dvh-10.25rem-1px-env(safe-area-inset-top)-env(safe-area-inset-bottom))] lg:h-[calc(100vh-4rem-3rem)]"
	>
		<!-- Sidebar: a column at md, an off-canvas drawer below it -->
		<UiRailDrawer
			id="chat-rail"
			v-model:open="railOpen"
			:navigation-title="t('components.chat.chatSidebar.title')"
		>
			<ChatSidebar
				class="flex-1 min-w-0"
				:channels="channels"
				:archived-channels="archivedChannels"
				:dms="dms"
				:is-loading="isLoading"
				:active-room-id="activeRoomId"
				:mention-count="mentionCount"
				@select="handleSelectRoom"
				@new-channel="showCreateChannel = true"
				@new-dm="showNewDm = true"
				@browse-channels="showBrowseChannels = true"
				@mentions="showMentions = true"
			/>
		</UiRailDrawer>

		<!-- Main column: the child page's root is the `flex-1 flex flex-col` column. -->
		<NuxtPage />

		<ChatNewChannelDialog
			v-if="showCreateChannel"
			@close="showCreateChannel = false"
			@created="
				(id) => {
					showCreateChannel = false;
					openRoom(id);
				}
			"
		/>
		<ChatNewDmDialog
			v-if="showNewDm"
			@close="showNewDm = false"
			@created="
				(id) => {
					showNewDm = false;
					openRoom(id);
				}
			"
		/>
		<ChatChannelBrowser v-if="showBrowseChannels" @close="showBrowseChannels = false" />
		<ChatMentionsDialog v-if="showMentions" @close="showMentions = false" />
	</div>
</template>
