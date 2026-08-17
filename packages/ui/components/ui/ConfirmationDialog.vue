<script setup lang="ts">
import { computed } from 'vue';
import { useUiI18n } from '../../composables/useUiI18n';

type Variant = 'danger' | 'warning' | 'default';

interface Props {
	open: boolean;
	/** Defaults to the localized "Are you sure?". */
	title?: string;
	/** Defaults to the localized "This action cannot be undone.". */
	description?: string;
	/** Defaults to the localized "Confirm". */
	confirmText?: string;
	/** Defaults to the localized "Cancel". */
	cancelText?: string;
	variant?: Variant;
	isLoading?: boolean;
	persistent?: boolean;
}

// The copy props have no defaults: prop defaults are evaluated outside the
// setup context, where `useUiI18n()` cannot run. They resolve below instead.
const props = withDefaults(defineProps<Props>(), {
	title: undefined,
	description: undefined,
	confirmText: undefined,
	cancelText: undefined,
	variant: 'default',
	isLoading: false,
	persistent: false,
});

const { t } = useUiI18n();

const resolvedTitle = computed(() => props.title ?? t('ui.confirmationDialog.title'));
const resolvedDescription = computed(
	() => props.description ?? t('ui.confirmationDialog.description')
);
const resolvedConfirmText = computed(() => props.confirmText ?? t('ui.actions.confirm'));
const resolvedCancelText = computed(() => props.cancelText ?? t('ui.actions.cancel'));

const emit = defineEmits<{
	'update:open': [value: boolean];
	confirm: [];
	cancel: [];
}>();

const variantConfig: Record<Variant, { icon: string; buttonClass: string; iconClass: string }> = {
	danger: {
		icon: 'lucide:trash-2',
		buttonClass: 'bg-error-strong hover:bg-error-strong/90 text-text-inverse',
		iconClass: 'bg-error/10 text-error',
	},
	warning: {
		icon: 'lucide:alert-triangle',
		buttonClass: 'bg-warning hover:bg-warning/90 text-bg-deep',
		iconClass: 'bg-warning/10 text-warning',
	},
	default: {
		icon: 'lucide:alert-triangle',
		buttonClass: 'bg-brand text-text-inverse hover:bg-brand-hover',
		iconClass: 'bg-brand/10 text-brand',
	},
};

const config = computed(() => variantConfig[props.variant]);

const close = () => {
	if (!props.isLoading) {
		emit('update:open', false);
	}
};

const handleConfirm = () => {
	emit('confirm');
};

const handleCancel = () => {
	emit('cancel');
	close();
};

const handleBackdropClick = () => {
	if (!props.persistent && !props.isLoading) {
		handleCancel();
	}
};
</script>

<template>
	<UiModal
		:open="open"
		:persistent="persistent || isLoading"
		:closable="!isLoading"
		@update:open="close"
	>
		<div class="flex flex-col items-center text-center">
			<div
				:class="['w-12 h-12 flex items-center justify-center rounded-full mb-4', config.iconClass]"
			>
				<Icon :name="config.icon" class="w-6 h-6" />
			</div>

			<h3 class="text-lg font-semibold text-text-primary mb-2">{{ resolvedTitle }}</h3>

			<p class="text-text-secondary">{{ resolvedDescription }}</p>

			<slot />
		</div>

		<template #footer>
			<UiButton variant="secondary" :disabled="isLoading" @click="handleCancel">
				{{ resolvedCancelText }}
			</UiButton>
			<button
				type="button"
				:class="[
					'inline-flex items-center justify-center gap-2 px-4 py-3 rounded-lg font-medium transition-[color,background-color,border-color,box-shadow,scale] duration-(--motion-fast) ease-spring active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base disabled:pointer-events-none disabled:opacity-50',
					config.buttonClass,
				]"
				:disabled="isLoading"
				@click="handleConfirm"
			>
				<Icon v-if="isLoading" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
				<Icon v-else :name="config.icon" class="w-4 h-4" />
				{{ isLoading ? t('ui.actions.pleaseWait') : resolvedConfirmText }}
			</button>
		</template>
	</UiModal>
</template>
