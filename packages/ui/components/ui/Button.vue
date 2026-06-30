<script setup lang="ts">
import { computed } from 'vue';

type ButtonVariant =
	| 'primary'
	| 'secondary'
	| 'outline'
	| 'ghost'
	| 'danger'
	| 'danger-ghost'
	| 'danger-outline';
type ButtonSize = 'sm' | 'md' | 'lg';

interface Props {
	variant?: ButtonVariant;
	size?: ButtonSize;
	loading?: boolean;
	disabled?: boolean;
	fullWidth?: boolean;
	type?: 'button' | 'submit' | 'reset';
}

const props = withDefaults(defineProps<Props>(), {
	variant: 'primary',
	size: 'md',
	loading: false,
	disabled: false,
	fullWidth: false,
	type: 'button',
});

const emit = defineEmits<{
	click: [event: MouseEvent];
}>();

const handleClick = (event: MouseEvent) => {
	if (props.disabled || props.loading) {
		event.preventDefault();
		return;
	}
	emit('click', event);
};

// The design system lives in assets/css/components.css (.btn / .btn-*);
// this component only composes those classes so the two cannot drift.
const base = 'btn';

const variantClasses: Record<ButtonVariant, string> = {
	primary: 'btn-primary',
	secondary: 'btn-secondary',
	outline: 'btn-outline',
	ghost: 'btn-ghost',
	danger: 'btn-danger',
	'danger-ghost': 'btn-danger-ghost',
	'danger-outline': 'btn-danger-outline',
};

const sizeClasses: Record<ButtonSize, string> = {
	sm: 'btn-sm',
	md: '',
	lg: 'btn-lg',
};

const buttonClasses = computed(() => {
	const classes = [base, variantClasses[props.variant], sizeClasses[props.size]];

	if (props.fullWidth) {
		classes.push('w-full');
	}

	return classes.join(' ');
});
</script>

<template>
	<button :type="type" :class="buttonClasses" :disabled="disabled || loading" @click="handleClick">
		<slot name="iconLeft" />
		<Icon v-if="loading" name="lucide:loader-2" class="w-4 h-4 animate-spin" :class="{ 'mr-2': $slots['default'] }" />
		<slot />
		<slot name="iconRight" />
	</button>
</template>
