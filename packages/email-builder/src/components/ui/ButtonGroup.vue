<script setup lang="ts">
import type { Component } from 'vue';

defineProps<{
	options: { value: string; icon: Component; label: string }[];
	value: string;
}>();

const emit = defineEmits<{
	(e: 'update', value: string): void;
}>();
</script>

<template>
	<div class="inline-flex border border-border-subtle rounded-lg overflow-hidden bg-bg-surface">
		<button
			v-for="(opt, i) in options"
			:key="opt.value"
			class="flex items-center justify-center w-[36px] h-8 cursor-pointer transition-[background-color,color] duration-(--motion-fast)"
			:class="[
				value === opt.value
					? 'bg-brand text-white shadow-[inset_0_1px_2px_rgba(0,0,0,0.2)]'
					: 'bg-transparent text-text-tertiary hover:bg-bg-surface-hover hover:text-text-secondary',
				i > 0 && 'border-l border-l-border-subtle',
			]"
			type="button"
			:title="opt.label"
			@click="emit('update', opt.value)"
		>
			<component :is="opt.icon" :size="16" />
		</button>
	</div>
</template>
