<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

const emit = defineEmits<{
	close: [];
	created: [roomId: Id<'chatRooms'>];
}>();

const name = ref('');
const description = ref('');
const visibility = ref<'public' | 'private'>('public');
const memberQuery = ref('');
const selectedMembers = ref<{ memberId: string; label: string }[]>([]);

const { candidates } = useChatMentionSearch(() => memberQuery.value, { includeAssistant: false });
const { createChannel } = useChatActions();
const isCreating = ref(false);
const error = ref<string | null>(null);

const selectedIds = computed(() => new Set(selectedMembers.value.map((m) => m.memberId)));
const addCandidates = computed(() => candidates.value.filter((c) => !selectedIds.value.has(c.memberId)));

const handleSubmit = async () => {
	if (!name.value.trim()) return;
	isCreating.value = true;
	error.value = null;
	try {
		const id = await createChannel({
			name: name.value,
			description: description.value || undefined,
			visibility: visibility.value,
			initialMemberIds: selectedMembers.value.map((m) => m.memberId),
		});
		if (id) emit('created', id);
	} catch (e) {
		error.value = e instanceof Error ? e.message : 'Failed to create channel';
	} finally {
		isCreating.value = false;
	}
};
</script>

<template>
	<ChatDialogShell title="New channel" @close="emit('close')">

				<div class="px-5 py-4 space-y-4">
					<div>
						<label for="name" class="block text-sm font-medium text-text-secondary mb-1.5">Name</label>
						<input id="name"
							v-model="name"
							type="text"
							placeholder="e.g. general"
							class="input w-full"
							@keydown.enter.prevent="handleSubmit"
						/>
					</div>
					<div>
						<label for="description" class="block text-sm font-medium text-text-secondary mb-1.5">
							Description <span class="text-text-tertiary font-normal">(optional)</span>
						</label>
						<input id="description"
							v-model="description"
							type="text"
							placeholder="What is this channel about?"
							class="input w-full"
						/>
					</div>
					<div>
						<label class="block text-sm font-medium text-text-secondary mb-1.5">Visibility</label>
						<div class="flex gap-2">
							<button
								class="flex-1 px-3 py-2 rounded-lg border text-sm transition-colors"
								:class="
									visibility === 'public'
										? 'bg-brand-subtle border-brand text-brand'
										: 'bg-bg-surface border-border-subtle text-text-secondary hover:text-text-primary'
								"
								@click="visibility = 'public'"
							>
								<Icon name="lucide:hash" class="w-4 h-4 inline mr-1" />
								Public
							</button>
							<button
								class="flex-1 px-3 py-2 rounded-lg border text-sm transition-colors"
								:class="
									visibility === 'private'
										? 'bg-brand-subtle border-brand text-brand'
										: 'bg-bg-surface border-border-subtle text-text-secondary hover:text-text-primary'
								"
								@click="visibility = 'private'"
							>
								<Icon name="lucide:lock" class="w-4 h-4 inline mr-1" />
								Private
							</button>
						</div>
					</div>

					<ChatMemberPicker
						v-model="selectedMembers"
						v-model:query="memberQuery"
						label="Initial members"
						label-hint="(optional)"
						placeholder="Search by name or email…"
					>
						<template #candidates="{ addMember }">
							<div
								v-if="memberQuery && addCandidates.length > 0"
								class="mt-2 max-h-32 overflow-y-auto space-y-1 bg-bg-surface border border-border-subtle rounded p-1"
							>
								<button
									v-for="candidate in addCandidates"
									:key="candidate.memberId"
									class="w-full text-left px-2 py-1 text-sm rounded hover:bg-bg-elevated text-text-primary"
									@click="addMember(candidate)"
								>
									{{ candidate.name ?? candidate.email ?? candidate.memberId }}
								</button>
							</div>
						</template>
					</ChatMemberPicker>

					<div v-if="error" class="text-sm text-error">{{ error }}</div>
				</div>

				<div class="flex items-center justify-end gap-3 px-5 py-4 border-t border-border-subtle">
					<button class="btn btn-secondary" @click="emit('close')">Cancel</button>
					<button
						class="btn btn-primary gap-2"
						:disabled="!name.trim() || isCreating"
						@click="handleSubmit"
					>
						<div
							v-if="isCreating"
							class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"
						/>
						<Icon v-else name="lucide:plus" class="w-4 h-4" />
						Create
					</button>
				</div>
	</ChatDialogShell>
</template>
