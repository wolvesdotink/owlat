<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

interface RoomItem {
	_id: Id<'chatRooms'>;
	kind: 'channel' | 'dm';
	displayName: string;
	visibility: 'public' | 'private';
	lastMessageAt: number;
	avatarSeed: string;
	unread: { unreadCount: number; hasMention: boolean };
}

interface Props {
	channels: RoomItem[];
	archivedChannels?: RoomItem[];
	dms: RoomItem[];
	activeRoomId?: Id<'chatRooms'>;
	isLoading: boolean;
	/** Unread @-mention count for the Mentions inbox badge. */
	mentionCount?: number;
}

const props = withDefaults(defineProps<Props>(), {
	archivedChannels: () => [],
	mentionCount: 0,
});

const showArchived = ref(false);

const archivedMatches = computed(() =>
	props.archivedChannels.filter((c) => matchesQuery(c.displayName)),
);

const emit = defineEmits<{
	select: [roomId: Id<'chatRooms'>];
	newChannel: [];
	newDm: [];
	browseChannels: [];
	mentions: [];
}>();

const searchQuery = ref('');

const matchesQuery = (name: string) => {
	const q = searchQuery.value.trim().toLowerCase();
	if (!q) return true;
	return name.toLowerCase().includes(q);
};
</script>

<template>
	<div class="flex flex-col h-full bg-bg-elevated border-r border-border-subtle">
		<!-- Header -->
		<div class="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
			<h2 class="text-sm font-semibold text-text-primary">Chat</h2>
			<button
				class="relative w-7 h-7 rounded flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
				title="Mentions"
				@click="emit('mentions')"
			>
				<Icon name="lucide:at-sign" class="w-4 h-4" />
				<span
					v-if="mentionCount > 0"
					class="absolute -top-0.5 -right-0.5 min-w-3.5 h-3.5 px-0.5 rounded-full bg-error text-white text-[9px] font-semibold flex items-center justify-center"
				>
					{{ mentionCount > 9 ? '9+' : mentionCount }}
				</span>
			</button>
		</div>

		<!-- Search -->
		<div class="px-3 py-2">
			<div class="relative">
				<Icon
					name="lucide:search"
					class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary"
				/>
				<input
					v-model="searchQuery"
					type="text"
					placeholder="Search…"
					class="w-full pl-9 pr-3 py-2 bg-bg-surface border border-border-subtle rounded-lg text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
				/>
			</div>
		</div>

		<!-- Lists -->
		<div class="flex-1 overflow-y-auto pb-3">
			<!-- Loading -->
			<div v-if="isLoading && channels.length === 0 && dms.length === 0" class="flex items-center justify-center py-12">
				<div class="w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
			</div>

			<template v-else>
				<!-- Channels -->
				<div class="px-3 mt-2">
					<div class="flex items-center justify-between px-1 py-1">
						<span class="text-[11px] uppercase tracking-wider font-semibold text-text-tertiary">
							Channels
						</span>
						<div class="flex items-center gap-1">
							<button
								class="w-6 h-6 rounded flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
								title="Browse channels"
								@click="emit('browseChannels')"
							>
								<Icon name="lucide:hash" class="w-3.5 h-3.5" />
							</button>
							<button
								class="w-6 h-6 rounded flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
								title="New channel"
								@click="emit('newChannel')"
							>
								<Icon name="lucide:plus" class="w-3.5 h-3.5" />
							</button>
						</div>
					</div>

					<div v-if="channels.length === 0" class="px-1 py-2 text-xs text-text-tertiary">
						No channels yet.
					</div>
					<button
						v-for="channel in channels.filter((c) => matchesQuery(c.displayName))"
						:key="channel._id"
						class="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors"
						:class="
							activeRoomId === channel._id
								? 'bg-brand-subtle text-brand'
								: 'text-text-secondary hover:bg-bg-surface hover:text-text-primary'
						"
						@click="emit('select', channel._id)"
					>
						<Icon
							:name="channel.visibility === 'private' ? 'lucide:lock' : 'lucide:hash'"
							class="w-4 h-4 flex-shrink-0"
						/>
						<span class="flex-1 truncate text-sm">
							{{ channel.displayName }}
						</span>
						<span
							v-if="channel.unread.hasMention"
							class="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-error text-white"
						>
							@
						</span>
						<span
							v-else-if="channel.unread.unreadCount > 0"
							class="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-brand text-white"
						>
							{{ channel.unread.unreadCount > 99 ? '99+' : channel.unread.unreadCount }}
						</span>
					</button>
				</div>

				<!-- Archived channels (collapsed by default) -->
				<div v-if="archivedChannels.length > 0" class="px-3 mt-3">
					<button
						class="w-full flex items-center gap-1.5 px-1 py-1 text-[11px] uppercase tracking-wider font-semibold text-text-tertiary hover:text-text-secondary transition-colors"
						@click="showArchived = !showArchived"
					>
						<Icon
							:name="showArchived ? 'lucide:chevron-down' : 'lucide:chevron-right'"
							class="w-3.5 h-3.5"
						/>
						<span>Archived</span>
						<span class="text-text-tertiary normal-case tracking-normal">({{ archivedChannels.length }})</span>
					</button>

					<template v-if="showArchived">
						<div v-if="archivedMatches.length === 0" class="px-1 py-2 text-xs text-text-tertiary">
							No matching archived channels.
						</div>
						<button
							v-for="channel in archivedMatches"
							:key="channel._id"
							class="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors"
							:class="
								activeRoomId === channel._id
									? 'bg-brand-subtle text-brand'
									: 'text-text-tertiary hover:bg-bg-surface hover:text-text-secondary'
							"
							@click="emit('select', channel._id)"
						>
							<Icon name="lucide:archive" class="w-4 h-4 flex-shrink-0" />
							<span class="flex-1 truncate text-sm">
								{{ channel.displayName }}
							</span>
						</button>
					</template>
				</div>

				<!-- DMs -->
				<div class="px-3 mt-4">
					<div class="flex items-center justify-between px-1 py-1">
						<span class="text-[11px] uppercase tracking-wider font-semibold text-text-tertiary">
							Direct messages
						</span>
						<button
							class="w-6 h-6 rounded flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
							title="New DM"
							@click="emit('newDm')"
						>
							<Icon name="lucide:plus" class="w-3.5 h-3.5" />
						</button>
					</div>

					<div v-if="dms.length === 0" class="px-1 py-2 text-xs text-text-tertiary">
						No conversations yet.
					</div>
					<button
						v-for="dm in dms.filter((d) => matchesQuery(d.displayName))"
						:key="dm._id"
						class="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors"
						:class="
							activeRoomId === dm._id
								? 'bg-brand-subtle text-brand'
								: 'text-text-secondary hover:bg-bg-surface hover:text-text-primary'
						"
						@click="emit('select', dm._id)"
					>
						<div
							class="w-5 h-5 rounded-full bg-bg-surface border border-border-subtle flex items-center justify-center text-[10px] font-medium text-text-tertiary flex-shrink-0"
						>
							{{ dm.avatarSeed.slice(0, 2).toUpperCase() }}
						</div>
						<span class="flex-1 truncate text-sm">
							{{ dm.displayName }}
						</span>
						<span
							v-if="dm.unread.unreadCount > 0"
							class="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-brand text-white"
						>
							{{ dm.unread.unreadCount > 99 ? '99+' : dm.unread.unreadCount }}
						</span>
					</button>
				</div>
			</template>
		</div>
	</div>
</template>
