<script setup lang="ts">
type AlertVariant = 'error' | 'warning' | 'info' | 'success';

interface Props {
	message: string;
	title?: string;
	variant?: AlertVariant;
}

const props = withDefaults(defineProps<Props>(), {
	title: undefined,
	variant: 'error',
});

const variantConfig: Record<AlertVariant, { icon: string; containerClass: string; iconClass: string }> = {
	error: {
		icon: 'lucide:alert-circle',
		containerClass: 'bg-error/10 border-error/20',
		iconClass: 'text-error',
	},
	warning: {
		icon: 'lucide:alert-triangle',
		containerClass: 'bg-warning/10 border-warning/20',
		iconClass: 'text-warning',
	},
	info: {
		icon: 'lucide:info',
		containerClass: 'bg-brand/10 border-brand/20',
		iconClass: 'text-brand',
	},
	success: {
		icon: 'lucide:check-circle',
		containerClass: 'bg-success/10 border-success/20',
		iconClass: 'text-success',
	},
};

const config = computed(() => variantConfig[props.variant]);

const defaultTitles: Record<AlertVariant, string> = {
	error: 'Error',
	warning: 'Warning',
	info: 'Info',
	success: 'Success',
};

const displayTitle = computed(() => props.title ?? defaultTitles[props.variant]);
</script>

<template>
	<div :class="['p-4 border rounded-lg flex items-start gap-3', config.containerClass]">
		<Icon :name="config.icon" :class="['w-5 h-5 shrink-0 mt-0.5', config.iconClass]" />
		<div>
			<p :class="['text-sm font-medium', config.iconClass]">{{ displayTitle }}</p>
			<p :class="['text-sm', `${config.iconClass}/80`]">{{ message }}</p>
		</div>
	</div>
</template>
