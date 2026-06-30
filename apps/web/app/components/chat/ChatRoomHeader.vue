<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

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
</script>

<template>
	<div class="flex items-center gap-3 px-4 py-3 border-b border-border-subtle bg-bg-elevated">
		<Icon
			:name="
				room.kind === 'dm'
					? 'lucide:user'
					: room.visibility === 'private'
						? 'lucide:lock'
						: 'lucide:hash'
			"
			class="w-5 h-5 text-text-secondary"
		/>
		<div class="flex-1 min-w-0">
			<div class="flex items-center gap-2">
				<h2 class="text-sm font-semibold text-text-primary truncate">
					{{ room.name }}
				</h2>
				<span
					v-if="room.linkedInboxThreadId"
					class="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-brand-subtle text-brand"
				>
					linked email
				</span>
				<span
					v-if="room.archivedAt"
					class="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-bg-surface text-text-tertiary"
				>
					archived
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
			<Icon name="lucide:users" class="w-3.5 h-3.5" />
			<span>{{ memberCount }}</span>
		</button>

		<div class="relative">
			<button
				class="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-bg-surface transition-colors"
				@click="showMenu = !showMenu"
			 aria-label="More actions">
				<Icon name="lucide:more-horizontal" class="w-4 h-4" />
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
					<Icon name="lucide:link" class="w-3.5 h-3.5" />
					{{ room.linkedInboxThreadId ? 'Change linked email' : 'Link an email thread' }}
				</button>
				<button
					v-if="room.kind === 'channel' && room.myRole === 'admin'"
					class="w-full text-left px-3 py-1.5 text-sm text-text-primary hover:bg-bg-surface flex items-center gap-2"
					@click="emit('editChannel')"
				>
					<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
					Edit channel
				</button>
				<button
					v-if="room.kind === 'channel' && room.myRole === 'admin' && !room.archivedAt"
					class="w-full text-left px-3 py-1.5 text-sm text-text-primary hover:bg-bg-surface flex items-center gap-2"
					@click="emit('archive')"
				>
					<Icon name="lucide:archive" class="w-3.5 h-3.5" />
					Archive channel
				</button>
				<button
					v-if="room.kind === 'channel' && room.myRole === 'admin' && room.archivedAt"
					class="w-full text-left px-3 py-1.5 text-sm text-text-primary hover:bg-bg-surface flex items-center gap-2"
					@click="emit('unarchive')"
				>
					<Icon name="lucide:archive-restore" class="w-3.5 h-3.5" />
					Unarchive channel
				</button>
				<button
					v-if="room.kind === 'channel' && room.isMember"
					class="w-full text-left px-3 py-1.5 text-sm text-text-primary hover:bg-bg-surface flex items-center gap-2"
					@click="emit('leave')"
				>
					<Icon name="lucide:log-out" class="w-3.5 h-3.5" />
					Leave channel
				</button>
			</div>
		</div>
	</div>
</template>
