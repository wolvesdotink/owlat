<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { PaperPlaneIcon } from '@coolicons/vue';

const emit = defineEmits<{
	close: [];
	created: [roomId: Id<'chatRooms'>];
}>();

const { t } = useI18n();
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
		if (id.ok) emit('created', id.result);
	} catch (e) {
		error.value = e instanceof Error ? e.message : t('components.chat.chatNewDmDialog.startFailed');
	} finally {
		isCreating.value = false;
	}
};
</script>

<template>
	<ChatDialogShell :title="t('components.chat.chatNewDmDialog.title')" @close="emit('close')">
		<div class="px-5 py-4 space-y-3">
			<ChatMemberPicker
				v-model="selectedMembers"
				v-model:query="memberQuery"
				:label="t('components.chat.chatNewDmDialog.toLabel')"
				:placeholder="t('components.chat.chatNewDmDialog.toPlaceholder')"
				:candidates="addCandidates"
				avatars
			/>
			<p class="text-xs text-text-tertiary">
				{{ t('components.chat.chatNewDmDialog.hint') }}
			</p>
			<div v-if="error" class="text-sm text-error">{{ error }}</div>
		</div>

		<div class="flex items-center justify-end gap-3 px-5 py-4 border-t border-border-subtle">
			<UiButton variant="secondary" @click="emit('close')">{{ t('common.cancel') }}</UiButton>
			<UiButton
				class="gap-2"
				:disabled="selectedMembers.length === 0 || isCreating"
				@click="handleSubmit"
			>
				<UiSpinner v-if="isCreating" size="xs" tone="inverse" />
				<PaperPlaneIcon v-else class="w-4 h-4" />
				{{ t('components.chat.chatNewDmDialog.startChat') }}
			</UiButton>
		</div>
	</ChatDialogShell>
</template>
