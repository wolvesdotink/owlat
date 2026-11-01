<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * The file detail page's tags card: the tags a person set (editable by admins,
 * as the backend's update is admin-only) and the ones the pipeline detected.
 */
const props = defineProps<{
	fileId: Id<'semanticFiles'>;
	tags?: string[];
	autoTags?: string[];
	isAdmin: boolean;
}>();

const { t } = useI18n();
const { showToast } = useToast();

const { run: updateFile } = useBackendOperation(api.semanticFiles.update, {
	label: () => t('dashboard.files.detail.updateOperation'),
});

const isEditingTags = ref(false);
const editTagsInput = ref('');

const startEditTags = () => {
	editTagsInput.value = (props.tags || []).join(', ');
	isEditingTags.value = true;
};

const saveTags = async () => {
	const tags = editTagsInput.value
		.split(',')
		.map((tag: string) => tag.trim())
		.filter(Boolean);
	const result = await updateFile({ fileId: props.fileId, tags });
	if (!result.ok) return;
	isEditingTags.value = false;
	showToast(t('dashboard.files.detail.toasts.tagsUpdated'));
};

const cancelEditTags = () => {
	isEditingTags.value = false;
};
</script>

<template>
	<div class="bg-bg-elevated shadow-surface-1 rounded-(--radius-card) p-5">
		<div class="flex items-center justify-between mb-3">
			<h3 class="text-sm font-semibold text-text-primary">
				{{ t('dashboard.files.detail.tags') }}
			</h3>
			<button
				v-if="!isEditingTags && isAdmin"
				class="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
				@click="startEditTags"
				:aria-label="t('common.edit')"
			>
				<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
			</button>
		</div>

		<div v-if="isEditingTags" class="space-y-3">
			<input
				v-model="editTagsInput"
				type="text"
				class="input input-sm"
				:placeholder="t('dashboard.files.detail.tagsPlaceholder')"
				@keyup.enter="saveTags"
			/>
			<div class="flex items-center gap-2">
				<button class="text-xs text-brand font-medium hover:underline" @click="saveTags">
					{{ t('common.save') }}
				</button>
				<button class="text-xs text-text-tertiary hover:text-text-primary" @click="cancelEditTags">
					{{ t('common.cancel') }}
				</button>
			</div>
		</div>

		<div v-else>
			<div v-if="tags && tags.length > 0" class="flex flex-wrap gap-1.5">
				<span
					v-for="tag in tags"
					:key="tag"
					class="inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full bg-bg-surface text-text-secondary"
				>
					{{ tag }}
				</span>
			</div>
			<p v-else class="text-sm text-text-tertiary">
				{{ t('dashboard.files.detail.noTags') }}
			</p>

			<!-- Auto tags -->
			<div v-if="autoTags && autoTags.length > 0" class="mt-3">
				<p class="text-xs text-text-tertiary mb-1.5">
					{{ t('dashboard.files.detail.autoDetected') }}
				</p>
				<div class="flex flex-wrap gap-1.5">
					<span
						v-for="tag in autoTags"
						:key="tag"
						class="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-brand-subtle/50 text-brand"
					>
						<Icon name="lucide:sparkles" class="w-3 h-3" />
						{{ tag }}
					</span>
				</div>
			</div>
		</div>
	</div>
</template>
