<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

const emit = defineEmits<{
	close: [];
	created: [roomId: Id<'chatRooms'>];
}>();

const { t } = useI18n();

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
const addCandidates = computed(() =>
	candidates.value.filter((c) => !selectedIds.value.has(c.memberId))
);

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
		error.value =
			e instanceof Error ? e.message : t('components.chat.chatNewChannelDialog.createFailed');
	} finally {
		isCreating.value = false;
	}
};
</script>

<template>
	<ChatDialogShell :title="t('components.chat.chatNewChannelDialog.title')" @close="emit('close')">
		<div class="px-5 py-4 space-y-4">
			<div>
				<label for="name" class="block text-sm font-medium text-text-secondary mb-1.5">
					{{ t('common.name') }}
				</label>
				<input
					id="name"
					v-model="name"
					type="text"
					:placeholder="t('components.chat.chatNewChannelDialog.namePlaceholder')"
					class="input w-full"
					@keydown.enter.prevent="handleSubmit"
				/>
			</div>
			<div>
				<label for="description" class="block text-sm font-medium text-text-secondary mb-1.5">
					{{ t('common.description') }}
					<span class="text-text-tertiary font-normal">
						{{ t('components.chat.chatNewChannelDialog.optionalHint') }}
					</span>
				</label>
				<input
					id="description"
					v-model="description"
					type="text"
					:placeholder="t('components.chat.chatNewChannelDialog.descriptionPlaceholder')"
					class="input w-full"
				/>
			</div>
			<div>
				<label class="block text-sm font-medium text-text-secondary mb-1.5">
					{{ t('components.chat.chatNewChannelDialog.visibility') }}
				</label>
				<div class="flex gap-2">
					<UiButton
						variant="outline"
						size="sm"
						class="flex-1"
						:class="visibility === 'public' ? 'bg-brand-subtle text-brand' : ''"
						@click="visibility = 'public'"
					>
						<template #iconLeft>
							<Icon name="lucide:hash" class="w-4 h-4" />
						</template>
						{{ t('components.chat.chatNewChannelDialog.public') }}
					</UiButton>
					<UiButton
						variant="outline"
						size="sm"
						class="flex-1"
						:class="visibility === 'private' ? 'bg-brand-subtle text-brand' : ''"
						@click="visibility = 'private'"
					>
						<template #iconLeft>
							<Icon name="lucide:lock" class="w-4 h-4" />
						</template>
						{{ t('components.chat.chatNewChannelDialog.private') }}
					</UiButton>
				</div>
			</div>

			<ChatMemberPicker
				v-model="selectedMembers"
				v-model:query="memberQuery"
				:label="t('components.chat.chatNewChannelDialog.initialMembers')"
				:label-hint="t('components.chat.chatNewChannelDialog.optionalHint')"
				:placeholder="t('components.chat.chatNewChannelDialog.membersPlaceholder')"
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
			<UiButton variant="secondary" @click="emit('close')">{{ t('common.cancel') }}</UiButton>
			<UiButton class="gap-2" :disabled="!name.trim() || isCreating" @click="handleSubmit">
				<UiSpinner v-if="isCreating" size="xs" tone="inverse" />
				<Icon v-else name="lucide:plus" class="w-4 h-4" />
				{{ t('common.create') }}
			</UiButton>
		</div>
	</ChatDialogShell>
</template>
