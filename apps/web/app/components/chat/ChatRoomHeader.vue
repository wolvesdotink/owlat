<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import {
	ArchiveIcon,
	ArchiveRestoreIcon,
	HashIcon,
	LinkIcon,
	LockIcon,
	LogOutIcon,
	MoreHorizontalIcon,
	PencilIcon,
	UserIcon,
	UsersIcon,
} from '@coolicons/vue';

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
	/** Whether the member list the members button toggles is open. */
	membersOpen?: boolean;
}

const props = defineProps<Props>();

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

const isChannelAdmin = computed(
	() => props.room.kind === 'channel' && props.room.myRole === 'admin'
);
const canLinkEmail = computed(
	() => isChannelAdmin.value && (!!props.room.linkedInboxThreadId || canReadInbox.value)
);
const canLeave = computed(() => props.room.kind === 'channel' && props.room.isMember);
const hasMenuItems = computed(() => isChannelAdmin.value || canLeave.value);

const { t } = useI18n();
</script>

<template>
	<div class="flex items-center gap-3 px-4 py-3 border-b border-border-subtle bg-bg-elevated">
		<component
			:is="room.kind === 'dm' ? UserIcon : room.visibility === 'private' ? LockIcon : HashIcon"
			class="w-5 h-5 text-text-secondary"
		/>
		<div class="flex-1 min-w-0">
			<div class="flex items-center gap-2">
				<h2 class="text-sm font-semibold text-text-primary truncate">
					{{ room.name }}
				</h2>
				<span
					v-if="canSeeLinkedEmail"
					class="text-2xs uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-brand-subtle text-brand"
				>
					{{ t('components.chat.chatRoomHeader.linkedEmailBadge') }}
				</span>
				<span
					v-if="room.archivedAt"
					class="text-2xs uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-bg-surface text-text-tertiary"
				>
					{{ t('components.chat.chatRoomHeader.archivedBadge') }}
				</span>
			</div>
			<p v-if="room.description" class="text-xs text-text-tertiary truncate">
				{{ room.description }}
			</p>
		</div>

		<UiTooltip :text="t('components.chat.chatMemberList.heading', { count: memberCount })">
			<button
				type="button"
				class="text-xs text-text-tertiary hover:text-text-primary px-2 py-1 pointer-coarse:min-h-11 rounded hover:bg-bg-surface transition-colors flex items-center gap-1.5"
				:aria-label="t('components.chat.chatMemberList.heading', { count: memberCount })"
				:aria-expanded="membersOpen"
				@click="emit('showMembers')"
			>
				<UsersIcon class="w-3.5 h-3.5" />
				<span>{{ memberCount }}</span>
			</button>
		</UiTooltip>

		<!-- A DM has none of these actions, so it shows no menu at all. -->
		<UiDropdownMenu v-if="hasMenuItems" v-model:open="showMenu">
			<template #trigger>
				<UiButton
					variant="ghost"
					size="sm"
					class="w-8 px-0"
					:aria-label="t('components.chat.chatRoomHeader.moreActions')"
				>
					<MoreHorizontalIcon class="w-4 h-4" />
				</UiButton>
			</template>
			<UiDropdownMenuItem v-if="canLinkEmail" :icon="LinkIcon" @click="emit('linkEmail')">
				{{
					room.linkedInboxThreadId
						? t('components.chat.chatRoomHeader.changeLinkedEmail')
						: t('components.chat.chatRoomHeader.linkEmailThread')
				}}
			</UiDropdownMenuItem>
			<UiDropdownMenuItem v-if="isChannelAdmin" :icon="PencilIcon" @click="emit('editChannel')">
				{{ t('components.chat.chatRoomHeader.editChannel') }}
			</UiDropdownMenuItem>
			<UiDropdownMenuItem
				v-if="isChannelAdmin && !room.archivedAt"
				:icon="ArchiveIcon"
				@click="emit('archive')"
			>
				{{ t('components.chat.chatRoomHeader.archiveChannel') }}
			</UiDropdownMenuItem>
			<UiDropdownMenuItem
				v-if="isChannelAdmin && room.archivedAt"
				:icon="ArchiveRestoreIcon"
				@click="emit('unarchive')"
			>
				{{ t('components.chat.chatRoomHeader.unarchiveChannel') }}
			</UiDropdownMenuItem>
			<UiDropdownMenuItem v-if="canLeave" :icon="LogOutIcon" danger @click="emit('leave')">
				{{ t('components.chat.chatRoomHeader.leaveChannel') }}
			</UiDropdownMenuItem>
		</UiDropdownMenu>
	</div>
</template>
