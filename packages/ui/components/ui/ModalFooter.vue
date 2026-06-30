<script setup lang="ts">
type ButtonVariant =
	| 'primary'
	| 'secondary'
	| 'outline'
	| 'ghost'
	| 'danger'
	| 'danger-ghost'
	| 'danger-outline';

interface Props {
	cancelText?: string;
	confirmText?: string;
	confirmVariant?: ButtonVariant;
	isLoading?: boolean;
	isDisabled?: boolean;
}

withDefaults(defineProps<Props>(), {
	cancelText: 'Cancel',
	confirmText: 'Confirm',
	confirmVariant: 'primary',
	isLoading: false,
	isDisabled: false,
});

defineEmits<{
	cancel: [];
	confirm: [];
}>();
</script>

<template>
	<div class="px-6 py-4 border-t border-border-subtle">
		<slot>
			<div class="flex justify-end gap-3">
				<UiButton variant="secondary" :disabled="isLoading" @click="$emit('cancel')">
					{{ cancelText }}
				</UiButton>
				<UiButton
					:variant="confirmVariant"
					:loading="isLoading"
					:disabled="isDisabled"
					@click="$emit('confirm')"
				>
					{{ confirmText }}
				</UiButton>
			</div>
		</slot>
	</div>
</template>
