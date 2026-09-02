<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

const { t } = useI18n();

useHead({ title: () => t('dashboard.chat.index.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'chat',
});

const router = useRouter();

const { channels, archivedChannels, dms, isLoading } = useChatRooms();
// Count only here; the Mentions dialog opens the 50-row feed lazily on demand.
const { count: mentionCount } = useChatMentions();

const showCreateChannel = ref(false);
const showNewDm = ref(false);
const showBrowseChannels = ref(false);
const showMentions = ref(false);

// Below md the rail is an off-canvas drawer (see UiRailDrawer) rather than a
// column, so the conversation list and its create actions stay reachable on a
// phone instead of being `hidden md:block`-ed away.
const railOpen = ref(false);

const handleSelectRoom = (id: Id<'chatRooms'>) => {
	railOpen.value = false;
	router.push(`/dashboard/chat/${id}`);
};
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
		<UiRailDrawer id="chat-rail" v-model:open="railOpen">
			<ChatSidebar
				class="flex-1 min-w-0"
				:channels="channels"
				:archived-channels="archivedChannels"
				:dms="dms"
				:is-loading="isLoading"
				:active-room-id="undefined"
				:mention-count="mentionCount"
				@select="handleSelectRoom"
				@new-channel="showCreateChannel = true"
				@new-dm="showNewDm = true"
				@browse-channels="showBrowseChannels = true"
				@mentions="showMentions = true"
			/>
		</UiRailDrawer>

		<div class="flex-1 flex flex-col min-w-0">
			<!-- Drawer handle — the only way to the room list below md. Named, like
			     the room view's sibling: a lone icon in an otherwise empty strip
			     reads as stray chrome and says nothing about what it opens. 44px
			     tall for the thumb; the negative inline margin keeps the icon
			     optically aligned with the content below. -->
			<div class="md:hidden px-3 border-b border-border-subtle">
				<button
					type="button"
					class="-mx-2 h-11 flex items-center gap-1.5 px-2 rounded text-text-secondary hover:text-text-primary hover:bg-bg-surface transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/40"
					aria-controls="chat-rail"
					:aria-expanded="railOpen"
					@click="railOpen = true"
				>
					<Icon name="lucide:panel-left" class="w-4 h-4" />
					<span class="text-sm">{{ t('dashboard.chat.index.openConversations') }}</span>
				</button>
			</div>

			<!-- Empty state -->
			<div class="flex-1 flex flex-col items-center justify-center text-center px-6">
				<div
					class="w-16 h-16 rounded-full bg-bg-surface border border-border-subtle flex items-center justify-center mb-4"
				>
					<Icon name="lucide:message-circle" class="w-8 h-8 text-text-tertiary" />
				</div>
				<h3 class="text-lg font-medium text-text-primary">
					{{ t('dashboard.chat.index.emptyTitle') }}
				</h3>
				<p class="text-sm text-text-secondary mt-1 max-w-sm">
					{{ t('dashboard.chat.index.emptyDescription') }}
				</p>
				<!-- Stacked below sm: side by side at 390px the two labels wrap
				     inside their own pills, and a button never wraps. -->
				<div class="mt-6 flex flex-col gap-3 sm:flex-row">
					<UiButton variant="secondary" class="gap-2" @click="showBrowseChannels = true">
						<Icon name="lucide:hash" class="w-4 h-4" />
						{{ t('dashboard.chat.index.browseChannels') }}
					</UiButton>
					<UiButton class="gap-2" @click="showCreateChannel = true">
						<Icon name="lucide:plus" class="w-4 h-4" />
						{{ t('dashboard.chat.index.newChannel') }}
					</UiButton>
				</div>
			</div>
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
	</div>
</template>
