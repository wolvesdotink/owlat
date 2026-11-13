<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { HashIcon } from '@coolicons/vue';

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const router = useRouter();
const { channels, isLoading } = useChatPublicChannels();

const search = ref('');

const filtered = computed(() => {
	const q = search.value.trim().toLowerCase();
	if (!q) return channels.value;
	return channels.value.filter(
		(c) => c.name.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q)
	);
});

const { run: joinMutate } = useBackendOperation(api.chat.members.joinChannel, {
	label: () => t('components.chat.chatChannelBrowser.operations.joinChannel'),
});

// The channel being joined: its button shows progress and a second click is ignored.
const joiningId = ref<Id<'chatRooms'> | null>(null);

const handleJoinAndOpen = async (channelId: Id<'chatRooms'>) => {
	if (joiningId.value) return;
	joiningId.value = channelId;
	let result;
	try {
		result = await joinMutate({ roomId: channelId });
	} finally {
		joiningId.value = null;
	}
	if (!result.ok) return;
	router.push(`/dashboard/chat/${channelId}`);
	emit('close');
};

const handleOpen = (channelId: Id<'chatRooms'>) => {
	router.push(`/dashboard/chat/${channelId}`);
	emit('close');
};
</script>

<template>
	<ChatDialogShell
		:title="t('components.chat.chatChannelBrowser.title')"
		size="lg"
		@close="emit('close')"
	>
		<div class="px-5 py-3 border-b border-border-subtle">
			<input
				v-model="search"
				type="text"
				:placeholder="t('components.chat.chatChannelBrowser.searchPlaceholder')"
				:aria-label="t('components.chat.chatChannelBrowser.searchPlaceholder')"
				class="input w-full"
			/>
		</div>

		<div class="flex-1 overflow-y-auto p-3">
			<div v-if="isLoading" class="flex items-center justify-center py-8">
				<UiSpinner size="md" delay />
			</div>
			<div v-else-if="filtered.length === 0" class="text-center py-8 text-text-tertiary text-sm">
				{{ t('components.chat.chatChannelBrowser.empty') }}
			</div>
			<div v-else class="space-y-1">
				<div
					v-for="channel in filtered"
					:key="channel._id"
					class="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-bg-surface transition-colors"
				>
					<HashIcon class="w-4 h-4 text-text-tertiary flex-shrink-0" />
					<div class="flex-1 min-w-0">
						<div class="text-sm font-medium text-text-primary truncate">
							{{ channel.name }}
						</div>
						<div v-if="channel.description" class="text-xs text-text-tertiary truncate">
							{{ channel.description }}
						</div>
					</div>
					<UiButton
						v-if="channel.isMember"
						variant="ghost"
						size="sm"
						@click="handleOpen(channel._id)"
					>
						{{ t('common.open') }}
					</UiButton>
					<UiButton
						v-else
						variant="secondary"
						size="sm"
						:loading="joiningId === channel._id"
						:disabled="joiningId !== null && joiningId !== channel._id"
						@click="handleJoinAndOpen(channel._id)"
					>
						{{ t('components.chat.chatChannelBrowser.join') }}
					</UiButton>
				</div>
			</div>
		</div>
	</ChatDialogShell>
</template>
