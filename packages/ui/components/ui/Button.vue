<script setup lang="ts">
import { computed, resolveComponent } from 'vue';

defineOptions({ inheritAttrs: false });

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
	to?: string;
	href?: string;
	target?: string;
	rel?: string;
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

// A link has no native `disabled`, so it gets `aria-disabled` from the props.
// A native button keeps the caller's own `aria-disabled` (the binding below
// runs after `v-bind="$attrs"` and would otherwise erase it): that is how a
// control stays in the tab order, announced as unavailable with its reason,
// while the caller's click handler keeps it inert. `disabled` would drop it
// from the tab order, so its reason could never be reached.
type Booleanish = boolean | 'true' | 'false' | undefined;

const element = computed(() => {
	if (props.to) return resolveComponent('NuxtLink');
	if (props.href) return 'a';
	return 'button';
});
</script>

<template>
	<component
		:is="element"
		v-bind="$attrs"
		:to="to"
		:href="href"
		:target="target"
		:rel="rel"
		:type="!to && !href ? type : undefined"
		:class="buttonClasses"
		:disabled="!to && !href ? disabled || loading : undefined"
		:aria-disabled="to || href ? disabled || loading : ($attrs['aria-disabled'] as Booleanish)"
		@click="handleClick"
	>
		<slot name="iconLeft" />
		<Icon
			v-if="loading"
			name="lucide:loader-2"
			class="w-4 h-4 animate-spin motion-reduce:animate-none"
			:class="{ 'mr-2': $slots['default'] }"
		/>
		<slot />
		<slot name="iconRight" />
	</component>
</template>
