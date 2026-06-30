<script setup lang="ts">
useHead({ title: 'Chat — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'chat',
});

const { channels, archivedChannels, dms, isLoading } = useChatRooms();
// Count only here; the Mentions dialog opens the 50-row feed lazily on demand.
const { count: mentionCount } = useChatMentions();

const showCreateChannel = ref(false);
const showNewDm = ref(false);
const showBrowseChannels = ref(false);
const showMentions = ref(false);
</script>

<template>
	<div class="flex h-[calc(100vh-4rem)] lg:h-[calc(100vh-4rem-3rem)]">
		<!-- Sidebar -->
		<div class="hidden md:block w-72 flex-shrink-0">
			<ChatSidebar
				:channels="channels"
				:archived-channels="archivedChannels"
				:dms="dms"
				:is-loading="isLoading"
				:active-room-id="undefined"
				:mention-count="mentionCount"
				@new-channel="showCreateChannel = true"
				@new-dm="showNewDm = true"
				@browse-channels="showBrowseChannels = true"
				@mentions="showMentions = true"
			/>
		</div>

		<!-- Empty state -->
		<div class="flex-1 flex flex-col items-center justify-center text-center px-6">
			<div
				class="w-16 h-16 rounded-full bg-bg-surface border border-border-subtle flex items-center justify-center mb-4"
			>
				<Icon name="lucide:message-circle" class="w-8 h-8 text-text-tertiary" />
			</div>
			<h3 class="text-lg font-medium text-text-primary">Team chat</h3>
			<p class="text-sm text-text-secondary mt-1 max-w-sm">
				Pick a channel or DM from the sidebar, or start something new.
			</p>
			<div class="mt-6 flex gap-3">
				<button class="btn btn-secondary gap-2" @click="showBrowseChannels = true">
					<Icon name="lucide:hash" class="w-4 h-4" />
					Browse channels
				</button>
				<button class="btn btn-primary gap-2" @click="showCreateChannel = true">
					<Icon name="lucide:plus" class="w-4 h-4" />
					New channel
				</button>
			</div>
		</div>

		<ChatNewChannelDialog
			v-if="showCreateChannel"
			@close="showCreateChannel = false"
		/>
		<ChatNewDmDialog v-if="showNewDm" @close="showNewDm = false" />
		<ChatChannelBrowser
			v-if="showBrowseChannels"
			@close="showBrowseChannels = false"
		/>
		<ChatMentionsDialog v-if="showMentions" @close="showMentions = false" />
	</div>
</template>
