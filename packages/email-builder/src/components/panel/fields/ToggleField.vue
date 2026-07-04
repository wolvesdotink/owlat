<script setup lang="ts">

defineProps<{
	value: boolean;
	label: string;
}>();

const emit = defineEmits<{
	(e: 'update', value: boolean): void;
}>();
</script>

<template>
	<div class="flex items-center justify-between gap-3 cursor-pointer select-none min-h-[34px]" @click="emit('update', !value)">
		<span class="text-[12.5px] font-medium text-text-primary tracking-[-0.01em]">{{ label }}</span>
		<button
			class="relative w-[38px] h-[22px] rounded-[11px] border-none cursor-pointer p-0 shrink-0 transition-[background] duration-(--motion-moderate)"
			:class="value ? 'bg-brand' : 'bg-bg-overlay'"
			type="button"
			role="switch"
			:aria-checked="value"
		>
			<span
				class="absolute top-0.5 left-0.5 w-[18px] h-[18px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.15),0_1px_1px_rgba(0,0,0,0.06)] transition-transform duration-(--motion-moderate) ease-[cubic-bezier(0.4,0,0.2,1)]"
				:class="value ? 'translate-x-4' : ''"
			/>
		</button>
	</div>
</template>

