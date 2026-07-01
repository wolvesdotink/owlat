<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const emit = defineEmits<{ close: [] }>();

const router = useRouter();
const { channels, isLoading } = useChatPublicChannels();

const search = ref('');

const filtered = computed(() => {
	const q = search.value.trim().toLowerCase();
	if (!q) return channels.value;
	return channels.value.filter(
		(c) =>
			c.name.toLowerCase().includes(q) ||
			(c.description ?? '').toLowerCase().includes(q),
	);
});

const { run: joinMutate } = useBackendOperation(api.chat.members.joinChannel, {
	label: 'Join channel',
});

const handleJoinAndOpen = async (channelId: Id<'chatRooms'>) => {
	const result = await joinMutate({ roomId: channelId });
	if (result === undefined) return;
	router.push(`/dashboard/chat/${channelId}`);
	emit('close');
};

const handleOpen = (channelId: Id<'chatRooms'>) => {
	router.push(`/dashboard/chat/${channelId}`);
	emit('close');
};
</script>

<template>
	<ChatDialogShell title="Browse channels" size="lg" @close="emit('close')">

				<div class="px-5 py-3 border-b border-border-subtle">
					<input
						v-model="search"
						type="text"
						placeholder="Search public channels…"
						class="input w-full"
					/>
				</div>

				<div class="flex-1 overflow-y-auto p-3">
					<div v-if="isLoading" class="flex items-center justify-center py-8">
						<UiSpinner size="md" />
					</div>
					<div v-else-if="filtered.length === 0" class="text-center py-8 text-text-tertiary text-sm">
						No public channels yet.
					</div>
					<div v-else class="space-y-1">
						<div
							v-for="channel in filtered"
							:key="channel._id"
							class="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-bg-surface transition-colors"
						>
							<Icon name="lucide:hash" class="w-4 h-4 text-text-tertiary flex-shrink-0" />
							<div class="flex-1 min-w-0">
								<div class="text-sm font-medium text-text-primary truncate">
									{{ channel.name }}
								</div>
								<div v-if="channel.description" class="text-xs text-text-tertiary truncate">
									{{ channel.description }}
								</div>
							</div>
							<button
								v-if="channel.isMember"
								class="text-xs text-text-secondary hover:text-text-primary px-2 py-1 rounded hover:bg-bg-elevated"
								@click="handleOpen(channel._id)"
							>
								Open
							</button>
							<button
								v-else
								class="text-xs text-brand hover:text-brand/80 font-medium px-2 py-1"
								@click="handleJoinAndOpen(channel._id)"
							>
								Join
							</button>
						</div>
					</div>
				</div>
	</ChatDialogShell>
</template>
