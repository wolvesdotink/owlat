<script setup lang="ts">
// The contact properties page's delete confirmation, with a warning when
// contacts hold a value for the property. The page loads the count and deletes.
import { CircleWarningIcon, TrashIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

defineProps<{
	/** The property up for deletion; the modal is open while it is set. */
	property: { label: string } | null;
	isLoadingUsageCount: boolean;
	usageCount: number;
	isDeleting: boolean;
}>();

const emit = defineEmits<{ close: []; confirm: [] }>();

const { t } = useI18n();
</script>

<template>
	<UiModal
		:open="!!property"
		:title="t('dashboard.admin.instance.properties.deleteModal.title')"
		@update:open="(v: boolean) => !v && emit('close')"
	>
		<I18nT
			keypath="dashboard.admin.instance.properties.deleteModal.question"
			tag="p"
			scope="global"
			class="text-text-secondary"
		>
			<template #name>
				<span v-if="property" class="font-medium text-text-primary">"{{ property.label }}"</span>
			</template>
		</I18nT>

		<!-- Warning about data -->
		<div
			v-if="isLoadingUsageCount"
			class="mt-4 p-4 rounded-xl bg-bg-surface border border-border-subtle flex items-center gap-3"
		>
			<SpinnerIcon class="w-4 h-4 text-text-tertiary" />
			<span class="text-sm text-text-tertiary">
				{{ t('dashboard.admin.instance.properties.deleteModal.checkingUsage') }}
			</span>
		</div>
		<div
			v-else-if="usageCount > 0"
			class="mt-4 p-4 rounded-xl bg-warning-subtle border border-warning/20"
		>
			<div class="flex items-start gap-3">
				<CircleWarningIcon class="w-5 h-5 text-warning mt-0.5 flex-shrink-0" />
				<div>
					<p class="font-medium text-warning">
						{{ t('dashboard.admin.instance.properties.deleteModal.dataWarningTitle') }}
					</p>
					<p class="text-sm text-warning/80 mt-1">
						{{
							t(
								'dashboard.admin.instance.properties.deleteModal.dataWarningBody',
								{ count: usageCount },
								usageCount
							)
						}}
					</p>
				</div>
			</div>
		</div>

		<template #footer>
			<UiButton variant="secondary" :disabled="isDeleting" @click="emit('close')">
				{{ t('common.cancel') }}
			</UiButton>
			<UiButton
				variant="danger"
				:loading="isDeleting"
				:disabled="isLoadingUsageCount"
				@click="emit('confirm')"
			>
				<template #iconLeft>
					<TrashIcon v-if="!isDeleting" class="w-4 h-4" />
				</template>
				{{
					isDeleting
						? t('dashboard.admin.instance.properties.deleteModal.deleting')
						: t('dashboard.admin.instance.properties.deleteModal.confirm')
				}}
			</UiButton>
		</template>
	</UiModal>
</template>
