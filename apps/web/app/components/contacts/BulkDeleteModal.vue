<script setup lang="ts">
const props = defineProps<{
	count: number;
}>();

const emit = defineEmits<{
	confirm: [];
}>();

const { t } = useI18n();

const isOpen = defineModel<boolean>('open', { default: false });

const close = () => {
	isOpen.value = false;
};

const handleConfirm = () => {
	emit('confirm');
};
</script>

<template>
	<UiModal :open="isOpen" size="md" @update:open="(v) => { if (!v) close(); }">
		<div class="flex items-center gap-3 mb-6">
			<div class="p-2 rounded-lg flex items-center justify-center bg-error-subtle">
				<Icon name="lucide:trash-2" class="w-5 h-5 text-error" />
			</div>
			<div>
				<h2 class="text-lg font-semibold text-text-primary">
					{{ t('components.contacts.bulkDeleteModal.title') }}
				</h2>
				<p class="text-sm text-text-tertiary">
					{{ t('components.contacts.bulkDeleteModal.subtitle') }}
				</p>
			</div>
		</div>
		<div class="p-4 rounded-lg bg-error-subtle border border-error/20 mb-4">
			<div class="flex gap-3">
				<Icon name="lucide:alert-circle" class="w-5 h-5 text-error flex-shrink-0 mt-0.5" />
				<div>
					<p class="text-sm text-error font-medium">
						{{ t('components.contacts.bulkDeleteModal.warning', { count }, count) }}
					</p>
					<p class="text-sm text-error/80 mt-1">
						{{ t('components.contacts.bulkDeleteModal.warningDetail') }}
					</p>
				</div>
			</div>
		</div>
		<p class="text-sm text-text-secondary">
			{{ t('components.contacts.bulkDeleteModal.confirmQuestion') }}
		</p>

		<template #footer>
			<UiButton variant="secondary" @click="close">{{ t('common.cancel') }}</UiButton>
			<UiButton variant="danger" @click="handleConfirm">
				<template #iconLeft><Icon name="lucide:trash-2" class="w-4 h-4" /></template>
				{{ t('components.contacts.bulkDeleteModal.confirm', { count }, count) }}
			</UiButton>
		</template>
	</UiModal>
</template>
