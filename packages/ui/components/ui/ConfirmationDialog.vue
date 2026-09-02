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

/**
 * The variant only chooses the icon and the tint behind it.
 *
 * It used to carry a `buttonClass` too — a terracotta fill for `default`, a
 * solid gold fill for `warning` — hand-written into a raw `<button>` that also
 * got `.btn`'s own recipe wrong (`rounded-lg`/`px-4` against `.btn`'s
 * `rounded-full`/`px-5`), so the confirm button was a different shape from the
 * Cancel button beside it. The confirm button is a `UiButton` now: `.btn-danger`
 * owns the only sanctioned solid danger fill and `.btn-primary` is the
 * monochrome default. The icon disc keeps its tint — a tint is not a fill.
 */
const variantConfig: Record<Variant, { icon: string; iconClass: string }> = {
	danger: {
		icon: 'lucide:trash-2',
		iconClass: 'bg-error/10 text-error',
	},
	warning: {
		icon: 'lucide:alert-triangle',
		iconClass: 'bg-warning/10 text-warning',
	},
	default: {
		icon: 'lucide:alert-triangle',
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
			<UiButton
				:variant="variant === 'danger' ? 'danger' : 'primary'"
				:loading="isLoading"
				@click="handleConfirm"
			>
				<template v-if="!isLoading" #iconLeft>
					<Icon :name="config.icon" class="w-4 h-4" />
				</template>
				{{ isLoading ? t('ui.actions.pleaseWait') : resolvedConfirmText }}
			</UiButton>
		</template>
	</UiModal>
</template>
