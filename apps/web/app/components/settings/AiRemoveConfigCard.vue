<script setup lang="ts">
/**
 * The AI-provider page's "Remove provider configuration" card and its
 * confirmation dialog. Removing deletes the stored row and its keys for good, so
 * the call only runs from the dialog. The page shows this card only while a row
 * is stored, and passes `remove`, which resolves `true` once the row is gone;
 * on a refused call the dialog stays open and the operation toast says why.
 */
const props = defineProps<{
	remove: () => Promise<boolean>;
	isRemoving: boolean;
	disabled?: boolean;
}>();

const { t } = useI18n();

const showDialog = ref(false);

async function confirmRemove() {
	if (await props.remove()) showDialog.value = false;
}
</script>

<template>
	<UiCard class="border-error/20">
		<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
			<div>
				<h2 class="text-lg font-medium text-text-primary mb-1">
					{{ t('dashboard.admin.instance.aiProvider.remove.title') }}
				</h2>
				<p class="text-sm text-text-secondary">
					{{ t('dashboard.admin.instance.aiProvider.remove.description') }}
				</p>
			</div>
			<UiButton
				type="button"
				variant="danger"
				class="shrink-0"
				:disabled="disabled || isRemoving"
				@click="showDialog = true"
			>
				<template #iconLeft>
					<Icon name="lucide:trash-2" class="w-4 h-4" />
				</template>
				{{ t('dashboard.admin.instance.aiProvider.remove.button') }}
			</UiButton>
		</div>

		<UiConfirmationDialog
			v-model:open="showDialog"
			variant="danger"
			:title="t('dashboard.admin.instance.aiProvider.remove.confirmTitle')"
			:description="t('dashboard.admin.instance.aiProvider.remove.confirmBody')"
			:confirm-text="t('dashboard.admin.instance.aiProvider.remove.confirm')"
			:is-loading="isRemoving"
			@confirm="confirmRemove"
		/>
	</UiCard>
</template>
