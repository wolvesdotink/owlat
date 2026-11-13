<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { HashIcon, LockIcon, PlusIcon } from '@coolicons/vue';

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
const nameId = useId();
const descriptionId = useId();
const visibilityLabelId = useId();
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
		if (id.ok) emit('created', id.result);
	} catch {
		// The server's own message is English and internal; say it in the reader's language.
		error.value = t('components.chat.chatNewChannelDialog.createFailed');
	} finally {
		isCreating.value = false;
	}
};
</script>

<template>
	<ChatDialogShell :title="t('components.chat.chatNewChannelDialog.title')" @close="emit('close')">
		<div class="px-5 py-4 space-y-4">
			<div>
				<label :for="nameId" class="block text-sm font-medium text-text-secondary mb-1.5">
					{{ t('common.name') }}
				</label>
				<input
					:id="nameId"
					v-model="name"
					type="text"
					:placeholder="t('components.chat.chatNewChannelDialog.namePlaceholder')"
					class="input w-full"
					@keydown.enter.prevent="handleSubmit"
				/>
			</div>
			<div>
				<label :for="descriptionId" class="block text-sm font-medium text-text-secondary mb-1.5">
					{{ t('common.description') }}
					<span class="text-text-tertiary font-normal">
						{{ t('components.chat.chatNewChannelDialog.optionalHint') }}
					</span>
				</label>
				<input
					:id="descriptionId"
					v-model="description"
					type="text"
					:placeholder="t('components.chat.chatNewChannelDialog.descriptionPlaceholder')"
					class="input w-full"
				/>
			</div>
			<div>
				<span :id="visibilityLabelId" class="block text-sm font-medium text-text-secondary mb-1.5">
					{{ t('components.chat.chatNewChannelDialog.visibility') }}
				</span>
				<div role="group" :aria-labelledby="visibilityLabelId" class="flex gap-2">
					<UiButton
						variant="outline"
						size="sm"
						class="flex-1"
						:class="visibility === 'public' ? 'bg-brand-subtle text-brand' : ''"
						:aria-pressed="visibility === 'public'"
						@click="visibility = 'public'"
					>
						<template #iconLeft>
							<HashIcon class="w-4 h-4" />
						</template>
						{{ t('components.chat.chatNewChannelDialog.public') }}
					</UiButton>
					<UiButton
						variant="outline"
						size="sm"
						class="flex-1"
						:class="visibility === 'private' ? 'bg-brand-subtle text-brand' : ''"
						:aria-pressed="visibility === 'private'"
						@click="visibility = 'private'"
					>
						<template #iconLeft>
							<LockIcon class="w-4 h-4" />
						</template>
						{{ t('components.chat.chatNewChannelDialog.private') }}
					</UiButton>
				</div>
				<p class="text-xs text-text-tertiary mt-1.5">
					{{
						visibility === 'private'
							? t('components.chat.chatNewChannelDialog.visibilityHint.private')
							: t('components.chat.chatNewChannelDialog.visibilityHint.public')
					}}
				</p>
			</div>

			<ChatMemberPicker
				v-model="selectedMembers"
				v-model:query="memberQuery"
				:label="t('components.chat.chatNewChannelDialog.initialMembers')"
				:label-hint="t('components.chat.chatNewChannelDialog.optionalHint')"
				:placeholder="t('components.chat.chatNewChannelDialog.membersPlaceholder')"
				:candidates="addCandidates"
			/>

			<div v-if="error" class="text-sm text-error">{{ error }}</div>
		</div>

		<div class="flex items-center justify-end gap-3 px-5 py-4 border-t border-border-subtle">
			<UiButton variant="secondary" @click="emit('close')">{{ t('common.cancel') }}</UiButton>
			<UiButton class="gap-2" :disabled="!name.trim() || isCreating" @click="handleSubmit">
				<UiSpinner v-if="isCreating" size="xs" tone="inverse" />
				<PlusIcon v-else class="w-4 h-4" />
				{{ t('common.create') }}
			</UiButton>
		</div>
	</ChatDialogShell>
</template>
