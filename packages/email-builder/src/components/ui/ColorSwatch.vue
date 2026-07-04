<script setup lang="ts">
defineProps<{
	color: string;
	selected?: boolean;
}>();

defineEmits<{
	(e: 'click'): void;
}>();
</script>

<template>
	<button
		class="w-[22px] h-[22px] rounded-[5px] border-[1.5px] border-border-subtle cursor-pointer p-0 transition-[transform,box-shadow,border-color] duration-(--motion-fast) shrink-0 hover:scale-[1.12] hover:border-text-tertiary"
		:class="{
			'bg-checker': color === 'transparent',
			'shadow-[0_0_0_2px_var(--color-brand)] border-brand scale-[1.08]': selected,
		}"
		:style="color !== 'transparent' ? { backgroundColor: color } : undefined"
		:title="color"
		type="button"
		@click="$emit('click')"
	/>
</template>
