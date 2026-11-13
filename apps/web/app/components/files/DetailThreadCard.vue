<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { ChatIcon, PencilIcon } from '@coolicons/vue';

/** The file detail page's linked conversation: a link into the team inbox, edited with the thread picker. */
const props = defineProps<{
	fileId: Id<'semanticFiles'>;
	threadId?: Id<'conversationThreads'>;
	threadSubject?: string;
	isAdmin: boolean;
}>();

const { t } = useI18n();
const { showToast } = useToast();

const { run: updateFile, isLoading: isSaving } = useBackendOperation(api.files.library.update, {
	label: () => t('dashboard.files.detail.updateOperation'),
});

const isEditingThread = ref(false);
const editThread = ref<PickerThread | null>(null);

// The linked conversation, as the picker's row shape. `get` returns the
// thread's subject alongside the file, so no extra thread fetch is needed.
const linkedThread = computed<PickerThread | null>(() =>
	props.threadId ? { _id: props.threadId, subject: props.threadSubject ?? '' } : null
);

const startEditThread = () => {
	editThread.value = linkedThread.value;
	isEditingThread.value = true;
};

const saveThread = async () => {
	if (isSaving.value) return;
	// `null` clears the link; the mutation treats an omitted arg as "unchanged".
	const result = await updateFile({
		fileId: props.fileId,
		threadId: editThread.value?._id ?? null,
	});
	if (!result.ok) return;
	isEditingThread.value = false;
	showToast(t('dashboard.files.detail.toasts.threadUpdated'));
};

const cancelEditThread = () => {
	isEditingThread.value = false;
};
</script>

<template>
	<div class="bg-surface-2 shadow-surface-1 rounded-(--radius-card) p-5">
		<div class="flex items-center justify-between mb-3">
			<h3 class="text-sm font-semibold text-text-primary">
				{{ t('dashboard.files.detail.linkedConversation') }}
			</h3>
			<button
				v-if="!isEditingThread && isAdmin"
				type="button"
				class="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
				:aria-label="t('dashboard.files.detail.editLinkedConversation')"
				@click="startEditThread"
			>
				<PencilIcon class="w-3.5 h-3.5" aria-hidden="true" />
			</button>
		</div>

		<!-- Edit: single-select thread picker -->
		<div v-if="isEditingThread" class="space-y-3">
			<FilesThreadPicker v-model="editThread" />
			<div class="flex items-center gap-2">
				<UiButton size="sm" :loading="isSaving" @click="saveThread">
					{{ t('common.save') }}
				</UiButton>
				<UiButton variant="ghost" size="sm" :disabled="isSaving" @click="cancelEditThread">
					{{ t('common.cancel') }}
				</UiButton>
			</div>
		</div>

		<!-- Read: the linked thread as a link into the team inbox -->
		<div v-else>
			<NuxtLink
				v-if="linkedThread"
				:to="`/dashboard/inbox/${linkedThread._id}`"
				class="flex items-center gap-2 p-2 -mx-2 rounded-lg hover:bg-bg-surface transition-colors"
			>
				<ChatIcon class="w-4 h-4 text-text-tertiary flex-shrink-0" aria-hidden="true" />
				<span
					class="text-sm text-brand hover:underline truncate"
					:title="threadPickerLabel(linkedThread)"
				>
					{{ threadPickerLabel(linkedThread) }}
				</span>
			</NuxtLink>
			<p v-else class="text-sm text-text-tertiary">
				{{ t('dashboard.files.detail.noLinkedConversation') }}
			</p>
		</div>
	</div>
</template>
