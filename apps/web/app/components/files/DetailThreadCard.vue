<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/** The file detail page's linked conversation: a link into the team inbox, edited with the thread picker. */
const props = defineProps<{
	fileId: Id<'semanticFiles'>;
	threadId?: Id<'conversationThreads'>;
	threadSubject?: string;
	isAdmin: boolean;
}>();

const { t } = useI18n();
const { showToast } = useToast();

const { run: updateFile } = useBackendOperation(api.files.library.update, {
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
	<div class="bg-bg-elevated border border-border-subtle rounded-lg p-5">
		<div class="flex items-center justify-between mb-3">
			<h3 class="text-sm font-semibold text-text-primary">
				{{ t('dashboard.files.detail.linkedConversation') }}
			</h3>
			<button
				v-if="!isEditingThread && isAdmin"
				class="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
				:aria-label="t('dashboard.files.detail.editLinkedConversation')"
				@click="startEditThread"
			>
				<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
			</button>
		</div>

		<!-- Edit: single-select thread picker -->
		<div v-if="isEditingThread" class="space-y-3">
			<FilesThreadPicker v-model="editThread" />
			<div class="flex items-center gap-2">
				<button class="text-xs text-brand font-medium hover:underline" @click="saveThread">
					{{ t('common.save') }}
				</button>
				<button
					class="text-xs text-text-tertiary hover:text-text-primary"
					@click="cancelEditThread"
				>
					{{ t('common.cancel') }}
				</button>
			</div>
		</div>

		<!-- Read: the linked thread as a link into the team inbox -->
		<div v-else>
			<NuxtLink
				v-if="linkedThread"
				:to="`/dashboard/inbox/${linkedThread._id}`"
				class="flex items-center gap-2 p-2 -mx-2 rounded-lg hover:bg-bg-surface transition-colors"
			>
				<Icon name="lucide:message-square" class="w-4 h-4 text-text-tertiary" />
				<span class="text-sm text-brand hover:underline truncate">
					{{ threadPickerLabel(linkedThread) }}
				</span>
			</NuxtLink>
			<p v-else class="text-sm text-text-tertiary">
				{{ t('dashboard.files.detail.noLinkedConversation') }}
			</p>
		</div>
	</div>
</template>
