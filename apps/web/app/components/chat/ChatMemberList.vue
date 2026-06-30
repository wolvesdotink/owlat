<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

interface Room {
	_id: Id<'chatRooms'>;
	kind: 'channel' | 'dm';
	myRole: 'admin' | 'member' | null;
}

interface Member {
	_id: Id<'chatRoomMembers'>;
	memberId: string;
	role: 'admin' | 'member';
	name: string | null;
	email: string | null;
	image: string | null;
}

interface Props {
	room: Room;
	members: Member[];
	currentUserId: string;
}

const props = defineProps<Props>();

const { removeMember, setMemberRole, addMember } = useChatActions();
const { candidates } = useChatMentionSearch(() => addQuery.value, { includeAssistant: false });

const canManage = computed(() => props.room.kind === 'channel' && props.room.myRole === 'admin');

const showAdd = ref(false);
const addQuery = ref('');

const memberIdSet = computed(() => new Set(props.members.map((m) => m.memberId)));

const addCandidates = computed(() =>
	candidates.value.filter((c) => !memberIdSet.value.has(c.memberId)),
);

const handleAdd = async (memberId: string) => {
	await addMember(props.room._id, memberId);
	addQuery.value = '';
};

const handlePromote = async (memberId: string) => {
	await setMemberRole(props.room._id, memberId, 'admin');
};
const handleDemote = async (memberId: string) => {
	await setMemberRole(props.room._id, memberId, 'member');
};
const memberToRemove = ref<Member | null>(null);
const isRemoving = ref(false);

const confirmRemove = async () => {
	const member = memberToRemove.value;
	if (!member) return;
	isRemoving.value = true;
	try {
		await removeMember(props.room._id, member.memberId);
	} finally {
		isRemoving.value = false;
		memberToRemove.value = null;
	}
};
</script>

<template>
	<div class="flex flex-col h-full">
		<div class="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
			<span class="text-sm font-semibold text-text-primary">
				Members ({{ members.length }})
			</span>
			<button
				v-if="canManage"
				class="text-xs text-brand hover:underline"
				@click="showAdd = !showAdd"
			>
				{{ showAdd ? 'Cancel' : 'Add' }}
			</button>
		</div>

		<!-- Add member -->
		<div v-if="showAdd && canManage" class="px-3 py-2 border-b border-border-subtle">
			<input
				v-model="addQuery"
				type="text"
				placeholder="Search org members…"
				class="w-full input text-sm"
			/>
			<div v-if="addCandidates.length > 0" class="mt-2 max-h-40 overflow-y-auto space-y-1">
				<button
					v-for="candidate in addCandidates"
					:key="candidate.memberId"
					class="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded hover:bg-bg-surface text-sm"
					@click="handleAdd(candidate.memberId)"
				>
					<div class="w-6 h-6 rounded-full bg-bg-surface border border-border-subtle flex items-center justify-center text-[10px] font-medium text-text-tertiary overflow-hidden">
						<img v-if="candidate.image" :src="candidate.image" class="w-full h-full object-cover" :alt="candidate.name ?? ''" />
						<span v-else>{{ (candidate.name ?? candidate.email ?? '?').slice(0, 2).toUpperCase() }}</span>
					</div>
					<span class="flex-1 truncate text-text-primary">
						{{ candidate.name ?? candidate.email ?? candidate.memberId }}
					</span>
				</button>
			</div>
		</div>

		<!-- Member list -->
		<div class="flex-1 overflow-y-auto py-2">
			<div
				v-for="member in members"
				:key="member._id"
				class="group flex items-center gap-3 px-3 py-1.5 hover:bg-bg-surface transition-colors"
			>
				<div class="w-7 h-7 rounded-full bg-bg-surface border border-border-subtle flex items-center justify-center text-[10px] font-medium text-text-tertiary overflow-hidden flex-shrink-0">
					<img v-if="member.image" :src="member.image" class="w-full h-full object-cover" :alt="member.name ?? ''" />
					<span v-else>{{ (member.name ?? member.email ?? '?').slice(0, 2).toUpperCase() }}</span>
				</div>
				<div class="flex-1 min-w-0">
					<div class="text-sm text-text-primary truncate">
						{{ member.name ?? member.email ?? member.memberId }}
						<span v-if="member.memberId === currentUserId" class="text-xs text-text-tertiary">(you)</span>
					</div>
					<div v-if="member.role === 'admin'" class="text-[10px] text-text-tertiary uppercase tracking-wider">
						Admin
					</div>
				</div>
				<div
					v-if="canManage && member.memberId !== currentUserId"
					class="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1"
				>
					<button
						v-if="member.role === 'member'"
						class="text-xs text-text-tertiary hover:text-brand"
						title="Promote to admin"
						@click="handlePromote(member.memberId)"
					>
						<Icon name="lucide:shield" class="w-3.5 h-3.5" />
					</button>
					<button
						v-else
						class="text-xs text-text-tertiary hover:text-text-primary"
						title="Demote to member"
						@click="handleDemote(member.memberId)"
					>
						<Icon name="lucide:shield-off" class="w-3.5 h-3.5" />
					</button>
					<button
						class="text-xs text-text-tertiary hover:text-error"
						title="Remove"
						@click="memberToRemove = member"
					>
						<Icon name="lucide:user-minus" class="w-3.5 h-3.5" />
					</button>
				</div>
			</div>
		</div>

		<UiConfirmationDialog
			:open="!!memberToRemove"
			variant="danger"
			title="Remove member?"
			:description="`Remove ${memberToRemove?.name ?? memberToRemove?.email ?? 'this member'} from the channel? They will lose access to it.`"
			confirm-text="Remove member"
			:is-loading="isRemoving"
			@update:open="(v: boolean) => !v && (memberToRemove = null)"
			@confirm="confirmRemove"
		/>
	</div>
</template>
