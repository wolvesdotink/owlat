<script setup lang="ts">
import { computed } from 'vue';

type Variant = 'danger' | 'warning' | 'default';

interface Props {
	open: boolean;
	title?: string;
	description?: string;
	confirmText?: string;
	cancelText?: string;
	variant?: Variant;
	isLoading?: boolean;
	persistent?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	title: 'Are you sure?',
	description: 'This action cannot be undone.',
	confirmText: 'Confirm',
	cancelText: 'Cancel',
	variant: 'default',
	isLoading: false,
	persistent: false,
});

const emit = defineEmits<{
	'update:open': [value: boolean];
	confirm: [];
	cancel: [];
}>();

const variantConfig: Record<Variant, { icon: string; buttonClass: string; iconClass: string }> = {
	danger: {
		icon: 'lucide:trash-2',
		buttonClass: 'bg-error hover:bg-error/90 text-white',
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

			<h3 class="text-lg font-semibold text-text-primary mb-2">{{ title }}</h3>

			<p class="text-text-secondary">{{ description }}</p>

			<slot />
		</div>

		<template #footer>
			<UiButton variant="secondary" :disabled="isLoading" @click="handleCancel">
				{{ cancelText }}
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
				{{ isLoading ? 'Please wait...' : confirmText }}
			</button>
		</template>
	</UiModal>
</template>
