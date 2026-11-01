<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { ArchiveIcon, HashIcon, LinkIcon, LockIcon, LogOutIcon, MoreHorizontalIcon, PencilIcon, RotateLeftIcon, UserIcon, UsersIcon } from '@coolicons/vue';

interface Room {
	_id: Id<'chatRooms'>;
	kind: 'channel' | 'dm';
	name: string;
	description?: string;
	visibility: 'public' | 'private';
	archivedAt?: number;
	linkedInboxThreadId?: Id<'conversationThreads'>;
	isMember: boolean;
	myRole: 'admin' | 'member' | null;
}

interface Props {
	room: Room;
	memberCount: number;
	/**
	 * Whether the viewer can read the linked Team Inbox thread. The server
	 * returns the linked-thread view only to shared-inbox readers, so the page
	 * passes whether it has one; the badge follows it, not the room's link.
	 */
	canSeeLinkedEmail: boolean;
}

defineProps<Props>();

const emit = defineEmits<{
	showMembers: [];
	linkEmail: [];
	editChannel: [];
	archive: [];
	unarchive: [];
	leave: [];
}>();

const showMenu = ref(false);

// The link-email dialog lists inbox threads via api.inbox.queries.listThreads,
// which only returns threads to org owners/admins — a per-room admin who is a
// plain org member would otherwise open an always-empty picker. Gate the "Link
// an email thread" affordance on the same capability; keep it shown for an
// already-linked room so the change/unlink action stays reachable.
const { canManageMembers: canReadInbox } = useOrganization();

const { t } = useI18n();
</script>

<template>
	<div class="flex items-center gap-3 px-4 py-3 border-b border-border-subtle bg-bg-elevated">
		<component
			:is="
				room.kind === 'dm'
					? UserIcon
					: room.visibility === 'private'
						? LockIcon
						: HashIcon
			"
			class="w-5 h-5 text-text-secondary"
		/>
		<div class="flex-1 min-w-0">
			<div class="flex items-center gap-2">
				<h2 class="text-sm font-semibold text-text-primary truncate">
					{{ room.name }}
				</h2>
				<span
					v-if="canSeeLinkedEmail"
					class="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-brand-subtle text-brand"
				>
					{{ t('components.chat.chatRoomHeader.linkedEmailBadge') }}
				</span>
				<span
					v-if="room.archivedAt"
					class="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-bg-surface text-text-tertiary"
				>
					{{ t('components.chat.chatRoomHeader.archivedBadge') }}
				</span>
			</div>
			<p v-if="room.description" class="text-xs text-text-tertiary truncate">
				{{ room.description }}
			</p>
		</div>

		<button
			class="text-xs text-text-tertiary hover:text-text-primary px-2 py-1 rounded hover:bg-bg-surface transition-colors flex items-center gap-1.5"
			@click="emit('showMembers')"
		>
			<UsersIcon class="w-3.5 h-3.5" />
			<span>{{ memberCount }}</span>
		</button>

		<div class="relative">
			<button
				class="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-bg-surface transition-colors"
				@click="showMenu = !showMenu"
			 :aria-label="t('components.chat.chatRoomHeader.moreActions')">
				<MoreHorizontalIcon class="w-4 h-4" />
			</button>

			<div
				v-if="showMenu"
				class="absolute right-0 top-full mt-1 w-48 bg-bg-elevated border border-border-subtle rounded-lg shadow-xl z-10 py-1"
				@click="showMenu = false"
			>
				<button
					v-if="room.kind === 'channel' && room.myRole === 'admin' && (!!room.linkedInboxThreadId || canReadInbox)"
					class="w-full text-left px-3 py-1.5 text-sm text-text-primary hover:bg-bg-surface flex items-center gap-2"
					@click="emit('linkEmail')"
				>
					<LinkIcon class="w-3.5 h-3.5" />
					{{
						room.linkedInboxThreadId
							? t('components.chat.chatRoomHeader.changeLinkedEmail')
							: t('components.chat.chatRoomHeader.linkEmailThread')
					}}
				</button>
				<button
					v-if="room.kind === 'channel' && room.myRole === 'admin'"
					class="w-full text-left px-3 py-1.5 text-sm text-text-primary hover:bg-bg-surface flex items-center gap-2"
					@click="emit('editChannel')"
				>
					<PencilIcon class="w-3.5 h-3.5" />
					{{ t('components.chat.chatRoomHeader.editChannel') }}
				</button>
				<button
					v-if="room.kind === 'channel' && room.myRole === 'admin' && !room.archivedAt"
					class="w-full text-left px-3 py-1.5 text-sm text-text-primary hover:bg-bg-surface flex items-center gap-2"
					@click="emit('archive')"
				>
					<ArchiveIcon class="w-3.5 h-3.5" />
					{{ t('components.chat.chatRoomHeader.archiveChannel') }}
				</button>
				<button
					v-if="room.kind === 'channel' && room.myRole === 'admin' && room.archivedAt"
					class="w-full text-left px-3 py-1.5 text-sm text-text-primary hover:bg-bg-surface flex items-center gap-2"
					@click="emit('unarchive')"
				>
					<RotateLeftIcon class="w-3.5 h-3.5" />
					{{ t('components.chat.chatRoomHeader.unarchiveChannel') }}
				</button>
				<button
					v-if="room.kind === 'channel' && room.isMember"
					class="w-full text-left px-3 py-1.5 text-sm text-text-primary hover:bg-bg-surface flex items-center gap-2"
					@click="emit('leave')"
				>
					<LogOutIcon class="w-3.5 h-3.5" />
					{{ t('components.chat.chatRoomHeader.leaveChannel') }}
				</button>
			</div>
		</div>
	</div>
</template>
