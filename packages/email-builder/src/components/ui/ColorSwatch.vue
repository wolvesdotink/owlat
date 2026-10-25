<script setup lang="ts">
import UiTooltip from '@owlat/ui/components/ui/Tooltip.vue';
import { useBuilderI18n } from '../../i18n/useBuilderI18n';

const { t } = useBuilderI18n();

defineProps<{
	color: string;
	selected?: boolean;
	/** Names the swatch when the raw colour value is not descriptive enough. */
	label?: string;
}>();

defineEmits<{
	(e: 'click'): void;
}>();
</script>

<template>
	<UiTooltip :text="label ?? color">
		<button
			class="w-[22px] h-[22px] rounded-[5px] border-[1.5px] border-border-subtle cursor-pointer p-0 transition-[transform,box-shadow,border-color] duration-(--motion-fast) shrink-0 hover:scale-[1.12] hover:border-text-tertiary"
			:class="{
				'bg-checker': color === 'transparent',
				'shadow-[0_0_0_2px_var(--color-brand)] border-brand scale-[1.08]': selected,
			}"
			:style="color !== 'transparent' ? { backgroundColor: color } : undefined"
			:aria-label="label ?? t('builder.panel.color.swatch', { color })"
			:aria-pressed="selected === true"
			type="button"
			@click="$emit('click')"
		/>
	</UiTooltip>
</template>
