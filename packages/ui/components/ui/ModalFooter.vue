<script setup lang="ts">
import { useUiI18n } from '../../composables/useUiI18n';

type ButtonVariant =
	| 'primary'
	| 'secondary'
	| 'outline'
	| 'ghost'
	| 'danger'
	| 'danger-ghost'
	| 'danger-outline';

interface Props {
	/** Defaults to the localized "Cancel". */
	cancelText?: string;
	/** Defaults to the localized "Confirm". */
	confirmText?: string;
	confirmVariant?: ButtonVariant;
	isLoading?: boolean;
	isDisabled?: boolean;
}

// The copy props have no defaults: prop defaults are evaluated outside the
// setup context, where `useUiI18n()` cannot run. They resolve below instead.
const props = withDefaults(defineProps<Props>(), {
	cancelText: undefined,
	confirmText: undefined,
	confirmVariant: 'primary',
	isLoading: false,
	isDisabled: false,
});

const { t } = useUiI18n();

const resolvedCancelText = computed(() => props.cancelText ?? t('ui.actions.cancel'));
const resolvedConfirmText = computed(() => props.confirmText ?? t('ui.actions.confirm'));

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
					{{ resolvedCancelText }}
				</UiButton>
				<UiButton
					:variant="confirmVariant"
					:loading="isLoading"
					:disabled="isDisabled"
					@click="$emit('confirm')"
				>
					{{ resolvedConfirmText }}
				</UiButton>
			</div>
		</slot>
	</div>
</template>
