<script setup lang="ts">
/**
 * Switch-track toggle (track + sliding thumb), the control the dashboard
 * previously hand-rolled in three divergent idioms — several copies without
 * role="switch". For the icon-style toggle see UiToggle; for tri-state pack
 * toggles (on/partial/off) keep a bespoke control.
 */
interface Props {
	modelValue?: boolean;
	disabled?: boolean;
	/** Accessible name — required when no visible label references the switch. */
	label?: string;
}

const props = withDefaults(defineProps<Props>(), {
	modelValue: false,
	disabled: false,
});

const emit = defineEmits<{
	'update:modelValue': [value: boolean];
}>();

const handleToggle = () => {
	if (props.disabled) return;
	emit('update:modelValue', !props.modelValue);
};
</script>

<template>
	<button
		type="button"
		role="switch"
		:aria-checked="modelValue"
		:aria-label="label"
		:disabled="disabled"
		:class="[
			'relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors duration-200',
			'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg-elevated',
			modelValue ? 'bg-brand' : 'bg-bg-surface-hover',
			disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
		]"
		@click="handleToggle"
	>
		<span
			:class="[
				'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform duration-200',
				modelValue ? 'translate-x-[22px]' : 'translate-x-[2px]',
			]"
		/>
	</button>
</template>
