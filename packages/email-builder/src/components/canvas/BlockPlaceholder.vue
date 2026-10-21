<script setup lang="ts">
import { useBuilderI18n } from '../../i18n/useBuilderI18n';

const { t } = useBuilderI18n();

const emit = defineEmits<{
	(e: 'click'): void;
}>();
</script>

<template>
	<button
		type="button"
		class="w-full text-left p-3 px-1 cursor-text rounded transition-[background-color] duration-(--motion-fast) hover:bg-bg-surface-hover"
		:aria-label="t('builder.canvas.placeholderAction')"
		@click="emit('click')"
	>
		<span class="text-sm text-text-tertiary pointer-events-none select-none">
			{{ t('builder.canvas.placeholderBefore') }}
			<kbd
				class="inline-block py-px px-[5px] text-xs font-[inherit] text-text-tertiary bg-bg-surface border border-border-subtle rounded mx-px"
				>/</kbd
			>
			{{ t('builder.canvas.placeholderAfter') }}
		</span>
	</button>
</template>
