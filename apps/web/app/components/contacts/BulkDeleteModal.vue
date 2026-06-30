<script setup lang="ts">
const props = defineProps<{
	count: number;
}>();

const emit = defineEmits<{
	confirm: [];
}>();

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
				<h2 class="text-lg font-semibold text-text-primary">Delete Contacts</h2>
				<p class="text-sm text-text-tertiary">This action cannot be undone</p>
			</div>
		</div>
		<div class="p-4 rounded-lg bg-error-subtle border border-error/20 mb-4">
			<div class="flex gap-3">
				<Icon name="lucide:alert-circle" class="w-5 h-5 text-error flex-shrink-0 mt-0.5" />
				<div>
					<p class="text-sm text-error font-medium">
						You are about to delete {{ count }} contact{{ count !== 1 ? 's' : '' }}
					</p>
					<p class="text-sm text-error/80 mt-1">
						This will also remove them from all topics and delete their custom
						property values.
					</p>
				</div>
			</div>
		</div>
		<p class="text-sm text-text-secondary">
			Are you sure you want to proceed? This action is permanent and cannot be reversed.
		</p>

		<template #footer>
			<UiButton variant="secondary" @click="close">Cancel</UiButton>
			<UiButton variant="danger" @click="handleConfirm">
				<template #iconLeft><Icon name="lucide:trash-2" class="w-4 h-4" /></template>
				Delete {{ count }} Contact{{ count !== 1 ? 's' : '' }}
			</UiButton>
		</template>
	</UiModal>
</template>
