<script setup lang="ts">
interface Props {
	modelValue?: boolean;
	disabled?: boolean;
	label?: string;
	size?: 'sm' | 'md';
}

const props = withDefaults(defineProps<Props>(), {
	modelValue: false,
	disabled: false,
	size: 'md',
});

const emit = defineEmits<{
	'update:modelValue': [value: boolean];
}>();

const handleToggle = () => {
	if (props.disabled) return;
	emit('update:modelValue', !props.modelValue);
};

const iconSize = computed(() => (props.size === 'sm' ? 'w-4 h-4' : 'w-5 h-5'));
</script>

<template>
	<button
		type="button"
		role="switch"
		:aria-checked="modelValue"
		:aria-label="label"
		:disabled="disabled"
		class="inline-flex items-center gap-2 p-2 rounded-lg bg-transparent text-text-secondary hover:text-text-primary hover:bg-bg-surface transition-colors duration-(--motion-fast) ease-spring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
		:class="{ 'opacity-50 cursor-not-allowed': disabled }"
		@click="handleToggle"
	>
		<Icon
			:name="modelValue ? 'lucide:toggle-right' : 'lucide:toggle-left'"
			:class="[iconSize, modelValue ? 'text-success' : 'text-text-tertiary']"
		/>
		<span v-if="label" class="text-sm font-medium text-text-primary">
			{{ label }}
		</span>
	</button>
</template>
