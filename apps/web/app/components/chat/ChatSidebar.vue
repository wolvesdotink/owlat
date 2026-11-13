<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { useComposerDrafts } from '~/composables/useComposerDrafts';
import DraftMarker from '~/components/shell/DraftMarker.vue';
import {
	ArchiveIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	HashIcon,
	LockIcon,
	MentionIcon,
	PlusIcon,
	SearchIcon,
} from '@coolicons/vue';

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
	/** The room lists' failed read: shown with Try again instead of "no channels". */
	error?: Error | null;
	/** Unread @-mention count for the Mentions inbox badge. */
	mentionCount?: number;
}

const props = withDefaults(defineProps<Props>(), {
	archivedChannels: () => [],
	error: null,
	mentionCount: 0,
});

const { t } = useI18n();
const drafts = useComposerDrafts();

const showArchived = ref(false);

const archivedMatches = computed(() =>
	props.archivedChannels.filter((c) => matchesQuery(c.displayName))
);

const emit = defineEmits<{
	select: [roomId: Id<'chatRooms'>];
	newChannel: [];
	newDm: [];
	browseChannels: [];
	mentions: [];
	retry: [];
}>();

const searchQuery = ref('');

const matchesQuery = (name: string) => {
	const q = searchQuery.value.trim().toLowerCase();
	if (!q) return true;
	return name.toLowerCase().includes(q);
};
const visibleChannels = computed(() => props.channels.filter((c) => matchesQuery(c.displayName)));
const visibleDms = computed(() => props.dms.filter((d) => matchesQuery(d.displayName)));
</script>

<template>
	<div class="flex flex-col h-full bg-bg-elevated border-r border-border-subtle">
		<!-- Header -->
		<div class="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
			<h2 class="text-sm font-semibold text-text-primary">
				{{ t('components.chat.chatSidebar.title') }}
			</h2>
			<UiTooltip :text="t('components.chat.chatSidebar.mentions')">
				<button
					type="button"
					class="relative w-7 h-7 pointer-coarse:size-11 rounded flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
					@click="emit('mentions')"
				>
					<!-- The name, with the badge's count after it: "Mentions 3". -->
					<span class="sr-only">{{ t('components.chat.chatSidebar.mentions') }}</span>
					<MentionIcon class="w-4 h-4" />
					<span
						v-if="mentionCount > 0"
						class="absolute -top-0.5 -right-0.5 min-w-3.5 h-3.5 px-0.5 rounded-full bg-error text-text-inverse text-2xs font-semibold flex items-center justify-center"
					>
						{{ mentionCount > 9 ? '9+' : mentionCount }}
					</span>
				</button>
			</UiTooltip>
		</div>

		<!-- Search -->
		<div class="px-3 py-2">
			<div class="relative">
				<SearchIcon class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary" />
				<input
					v-model="searchQuery"
					type="text"
					:placeholder="t('components.chat.chatSidebar.searchPlaceholder')"
					:aria-label="t('components.chat.chatSidebar.searchLabel')"
					class="input input-sm pl-9"
				/>
			</div>
		</div>

		<!-- Lists -->
		<div class="flex-1 overflow-y-auto pb-3">
			<!-- Loading -->
			<div v-if="isLoading && channels.length === 0 && dms.length === 0" aria-busy="true">
				<p role="status" class="sr-only">{{ t('common.loading') }}</p>
				<!-- The two sections' shape: a caption, then icon + name rows. -->
				<div v-for="section in 2" :key="section" aria-hidden="true" class="px-3 mt-2">
					<UiSkeleton class="h-3 w-16 mx-1 my-1.5" />
					<div v-for="row in 3" :key="row" class="flex items-center gap-2 px-2 py-1.5">
						<UiSkeleton :circle="section === 2" class="size-4 shrink-0" />
						<UiSkeleton class="h-3.5" :class="row === 2 ? 'w-20' : 'w-28'" />
					</div>
				</div>
			</div>

			<UiQueryBoundary
				v-else-if="error && channels.length === 0 && dms.length === 0"
				:error="error"
				@retry="emit('retry')"
			/>

			<template v-else>
				<!-- Channels -->
				<div class="px-3 mt-2">
					<div class="flex items-center justify-between px-1 py-1">
						<span class="text-2xs uppercase tracking-wider font-semibold text-text-tertiary">
							{{ t('components.chat.chatSidebar.channels') }}
						</span>
						<div class="flex items-center gap-1">
							<UiTooltip :text="t('components.chat.chatSidebar.browseChannels')">
								<button
									type="button"
									class="w-6 h-6 pointer-coarse:size-11 rounded flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
									:aria-label="t('components.chat.chatSidebar.browseChannels')"
									@click="emit('browseChannels')"
								>
									<HashIcon class="w-3.5 h-3.5" />
								</button>
							</UiTooltip>
							<UiTooltip :text="t('components.chat.chatSidebar.newChannel')">
								<button
									type="button"
									class="w-6 h-6 pointer-coarse:size-11 rounded flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
									:aria-label="t('components.chat.chatSidebar.newChannel')"
									@click="emit('newChannel')"
								>
									<PlusIcon class="w-3.5 h-3.5" />
								</button>
							</UiTooltip>
						</div>
					</div>

					<div v-if="channels.length === 0" class="px-1 py-2 text-xs text-text-tertiary">
						{{ t('components.chat.chatSidebar.noChannels') }}
					</div>
					<div
						v-else-if="visibleChannels.length === 0"
						class="px-1 py-2 text-xs text-text-tertiary"
					>
						{{ t('components.chat.chatSidebar.noMatches') }}
					</div>
					<button
						v-for="channel in visibleChannels"
						:key="channel._id"
						type="button"
						class="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors"
						:aria-current="activeRoomId === channel._id ? 'page' : undefined"
						:class="
							activeRoomId === channel._id
								? 'bg-brand-subtle text-brand'
								: 'text-text-secondary hover:bg-bg-surface hover:text-text-primary'
						"
						@click="emit('select', channel._id)"
					>
						<component
							:is="channel.visibility === 'private' ? LockIcon : HashIcon"
							class="w-4 h-4 flex-shrink-0"
						/>
						<span class="flex-1 truncate text-sm">
							{{ channel.displayName }}
						</span>
						<DraftMarker v-if="drafts.has('chat', channel._id)" />
						<template v-if="channel.unread.hasMention">
							<span
								aria-hidden="true"
								class="text-2xs font-semibold px-1.5 py-0.5 rounded-full bg-error text-text-inverse"
							>
								@
							</span>
							<span class="sr-only">{{ t('components.chat.chatSidebar.mentionedYou') }}</span>
						</template>
						<template v-else-if="channel.unread.unreadCount > 0">
							<span
								aria-hidden="true"
								class="text-2xs font-semibold px-1.5 py-0.5 rounded-full bg-text-primary text-text-inverse"
							>
								{{ channel.unread.unreadCount > 99 ? '99+' : channel.unread.unreadCount }}
							</span>
							<span class="sr-only">{{
								t('components.chat.chatSidebar.unreadCount', { count: channel.unread.unreadCount })
							}}</span>
						</template>
					</button>
				</div>

				<!-- Archived channels (collapsed by default) -->
				<div v-if="archivedChannels.length > 0" class="px-3 mt-3">
					<button
						type="button"
						:aria-expanded="showArchived"
						class="w-full flex items-center gap-1.5 px-1 py-1 text-2xs uppercase tracking-wider font-semibold text-text-tertiary hover:text-text-secondary transition-colors"
						@click="showArchived = !showArchived"
					>
						<component
							:is="showArchived ? ChevronDownIcon : ChevronRightIcon"
							class="w-3.5 h-3.5"
						/>
						<span>{{ t('components.chat.chatSidebar.archived') }}</span>
						<span class="text-text-tertiary normal-case tracking-normal"
							>({{ archivedChannels.length }})</span
						>
					</button>

					<template v-if="showArchived">
						<div v-if="archivedMatches.length === 0" class="px-1 py-2 text-xs text-text-tertiary">
							{{ t('components.chat.chatSidebar.noArchivedMatches') }}
						</div>
						<button
							v-for="channel in archivedMatches"
							:key="channel._id"
							type="button"
							class="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors"
							:aria-current="activeRoomId === channel._id ? 'page' : undefined"
							:class="
								activeRoomId === channel._id
									? 'bg-brand-subtle text-brand'
									: 'text-text-tertiary hover:bg-bg-surface hover:text-text-secondary'
							"
							@click="emit('select', channel._id)"
						>
							<ArchiveIcon class="w-4 h-4 flex-shrink-0" />
							<span class="flex-1 truncate text-sm">
								{{ channel.displayName }}
							</span>
						</button>
					</template>
				</div>

				<!-- DMs -->
				<div class="px-3 mt-4">
					<div class="flex items-center justify-between px-1 py-1">
						<span class="text-2xs uppercase tracking-wider font-semibold text-text-tertiary">
							{{ t('components.chat.chatSidebar.directMessages') }}
						</span>
						<UiTooltip :text="t('components.chat.chatSidebar.newDm')">
							<button
								type="button"
								class="w-6 h-6 pointer-coarse:size-11 rounded flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
								:aria-label="t('components.chat.chatSidebar.newDm')"
								@click="emit('newDm')"
							>
								<PlusIcon class="w-3.5 h-3.5" />
							</button>
						</UiTooltip>
					</div>

					<div v-if="dms.length === 0" class="px-1 py-2 text-xs text-text-tertiary">
						{{ t('components.chat.chatSidebar.noDms') }}
					</div>
					<div v-else-if="visibleDms.length === 0" class="px-1 py-2 text-xs text-text-tertiary">
						{{ t('components.chat.chatSidebar.noMatches') }}
					</div>
					<button
						v-for="dm in visibleDms"
						:key="dm._id"
						type="button"
						class="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors"
						:aria-current="activeRoomId === dm._id ? 'page' : undefined"
						:class="
							activeRoomId === dm._id
								? 'bg-brand-subtle text-brand'
								: 'text-text-secondary hover:bg-bg-surface hover:text-text-primary'
						"
						@click="emit('select', dm._id)"
					>
						<UiAvatar :name="dm.avatarSeed" size="xs" class="flex-shrink-0" />
						<span class="flex-1 truncate text-sm">
							{{ dm.displayName }}
						</span>
						<DraftMarker v-if="drafts.has('chat', dm._id)" />
						<template v-if="dm.unread.unreadCount > 0">
							<span
								aria-hidden="true"
								class="text-2xs font-semibold px-1.5 py-0.5 rounded-full bg-text-primary text-text-inverse"
							>
								{{ dm.unread.unreadCount > 99 ? '99+' : dm.unread.unreadCount }}
							</span>
							<span class="sr-only">{{
								t('components.chat.chatSidebar.unreadCount', { count: dm.unread.unreadCount })
							}}</span>
						</template>
					</button>
				</div>
			</template>
		</div>
	</div>
</template>
