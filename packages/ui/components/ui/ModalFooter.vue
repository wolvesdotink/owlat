<script setup lang="ts">
import { useUiI18n } from '../../composables/useUiI18n';

type ButtonVariant =
	| 'primary'
	| 'secondary'
	| 'outline'
	| 'ghost'
	| 'danger'
	| 'danger-ghost'
	| 'danger-outline'
	| 'warning'
	| 'warning-ghost';

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
	<!-- A button row only: UiModal's #footer slot already pads and pins the
	     footer, so a padding or border here doubles it. Wraps so two long
	     labels (German) never run past a phone sheet's edge. -->
	<div class="flex flex-wrap items-center justify-end gap-3">
		<slot>
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
		</slot>
	</div>
</template>
