<script setup lang="ts">
// The contact properties page's edit modal. Only the label can change; the
// key is shown read-only. The page validates and saves.
import { CheckIcon, type IconComponent } from '@coolicons/vue';

defineProps<{
	property: { key: string } | null;
	typeIcon: IconComponent;
	/** The page's edit draft; the input writes into it in place. */
	form: { label: string };
	errors: { label: string };
	isSaving: boolean;
}>();

const emit = defineEmits<{ submit: [] }>();

const isEditModalOpen = defineModel<boolean>('open', { required: true });

const { t } = useI18n();
</script>

<template>
	<UiModal
		v-model:open="isEditModalOpen"
		:title="t('dashboard.admin.instance.properties.editModal.title')"
	>
		<div class="space-y-4">
			<!-- Property Info (Read-only) -->
			<div v-if="property" class="p-4 rounded-xl bg-bg-surface border border-border-subtle">
				<div class="flex items-center gap-3">
					<div class="p-2 rounded-lg bg-bg-elevated flex items-center justify-center">
						<component :is="typeIcon" class="w-5 h-5 text-text-secondary" />
					</div>
					<div>
						<p class="text-sm text-text-tertiary">
							{{ t('dashboard.admin.instance.properties.fields.key') }}
						</p>
						<p class="font-mono text-text-primary">{{ property.key }}</p>
					</div>
				</div>
				<p class="mt-3 text-xs text-text-tertiary">
					{{ t('dashboard.admin.instance.properties.editModal.immutable') }}
				</p>
			</div>

			<!-- Label -->
			<UiInput
				v-model="form.label"
				:label="t('dashboard.admin.instance.properties.fields.label')"
				:placeholder="t('dashboard.admin.instance.properties.fields.labelPlaceholder')"
				:error="errors.label"
				:disabled="isSaving"
				:required="true"
			/>
		</div>

		<template #footer>
			<UiButton variant="secondary" :disabled="isSaving" @click="isEditModalOpen = false">
				{{ t('common.cancel') }}
			</UiButton>
			<UiButton :loading="isSaving" @click="emit('submit')">
				<template #iconLeft>
					<CheckIcon v-if="!isSaving" class="w-4 h-4" />
				</template>
				{{
					isSaving
						? t('dashboard.admin.instance.properties.editModal.saving')
						: t('dashboard.admin.instance.properties.editModal.save')
				}}
			</UiButton>
		</template>
	</UiModal>
</template>
