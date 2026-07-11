<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

const emit = defineEmits<{
	close: [];
	created: [roomId: Id<'chatRooms'>];
}>();

const { user } = useAuth();
const memberQuery = ref('');
const selectedMembers = ref<{ memberId: string; label: string }[]>([]);

const { candidates } = useChatMentionSearch(() => memberQuery.value, { includeAssistant: false });
const { findOrCreateDm } = useChatActions();
const isCreating = ref(false);
const error = ref<string | null>(null);

const selectedIds = computed(() => new Set(selectedMembers.value.map((m) => m.memberId)));
// DM dialog additionally excludes the current user from candidates.
const addCandidates = computed(() =>
	candidates.value.filter(
		(c) => !selectedIds.value.has(c.memberId) && c.memberId !== user.value?.id
	)
);

const handleSubmit = async () => {
	if (selectedMembers.value.length === 0) return;
	isCreating.value = true;
	error.value = null;
	try {
		const id = await findOrCreateDm(selectedMembers.value.map((m) => m.memberId));
		if (id) emit('created', id);
	} catch (e) {
		error.value = e instanceof Error ? e.message : 'Failed to start DM';
	} finally {
		isCreating.value = false;
	}
};
</script>

<template>
	<ChatDialogShell title="New direct message" @close="emit('close')">
		<div class="px-5 py-4 space-y-3">
			<ChatMemberPicker
				v-model="selectedMembers"
				v-model:query="memberQuery"
				label="To"
				placeholder="Search teammates by name or email…"
			>
				<template #candidates="{ addMember }">
					<div
						v-if="memberQuery && addCandidates.length > 0"
						class="mt-2 max-h-48 overflow-y-auto space-y-1 bg-bg-surface border border-border-subtle rounded p-1"
					>
						<button
							v-for="candidate in addCandidates"
							:key="candidate.memberId"
							class="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-bg-elevated text-text-primary flex items-center gap-2"
							@click="addMember(candidate)"
						>
							<UiAvatar
								:name="candidate.name"
								:email="candidate.email"
								:image="candidate.image"
								size="sm"
								bg="elevated"
							/>
							<span>{{ candidate.name ?? candidate.email ?? candidate.memberId }}</span>
						</button>
					</div>
				</template>
			</ChatMemberPicker>
			<p class="text-xs text-text-tertiary">
				Pick one teammate for a 1:1 DM, or multiple for a group chat.
			</p>
			<div v-if="error" class="text-sm text-error">{{ error }}</div>
		</div>

		<div class="flex items-center justify-end gap-3 px-5 py-4 border-t border-border-subtle">
			<button class="btn btn-secondary" @click="emit('close')">Cancel</button>
			<button
				class="btn btn-primary gap-2"
				:disabled="selectedMembers.length === 0 || isCreating"
				@click="handleSubmit"
			>
				<UiSpinner v-if="isCreating" size="xs" tone="inverse" />
				<Icon v-else name="lucide:send" class="w-4 h-4" />
				Start chat
			</button>
		</div>
	</ChatDialogShell>
</template>
