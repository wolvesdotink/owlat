<script setup lang="ts">
interface Props {
	icon?: string;
	disabled?: boolean;
	danger?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	icon: undefined,
	disabled: false,
	danger: false,
});

const emit = defineEmits<{
	click: [event: MouseEvent];
}>();

// Inject close function from parent dropdown
const closeDropdown = inject<() => void>('dropdownClose', () => {});

const handleClick = (event: MouseEvent) => {
	if (props.disabled) {
		event.preventDefault();
		return;
	}
	emit('click', event);
	closeDropdown();
};

const itemClasses = computed(() => {
	const base = 'w-full px-3 py-2 text-left text-sm flex items-center gap-2 transition-colors';

	if (props.disabled) {
		return `${base} text-text-tertiary cursor-not-allowed opacity-50`;
	}

	if (props.danger) {
		return `${base} text-error hover:bg-error/10`;
	}

	return `${base} text-text-primary hover:bg-bg-surface`;
});
</script>

<template>
	<button role="menuitem" :tabindex="disabled ? -1 : 0" :class="itemClasses" :disabled="disabled" @click="handleClick">
		<Icon v-if="icon" :name="icon" class="w-4 h-4" />
		<slot />
	</button>
</template>
