<script setup lang="ts">
import { computed } from 'vue';
import { AlignLeft, AlignCenter, AlignRight, AlignJustify, Maximize2 } from '@lucide/vue';
import ButtonGroup from '../../ui/ButtonGroup.vue';
import { useBuilderI18n } from '../../../i18n/useBuilderI18n';

const { t } = useBuilderI18n();

const props = defineProps<{
	value: string;
	options?: string[];
}>();

const emit = defineEmits<{
	(e: 'update', value: string): void;
}>();

const iconMap: Record<string, typeof AlignLeft> = {
	left: AlignLeft,
	center: AlignCenter,
	right: AlignRight,
	justify: AlignJustify,
	full: Maximize2,
};

const groupOptions = computed(() =>
	(props.options ?? ['left', 'center', 'right']).map((align) => ({
		value: align,
		icon: iconMap[align] ?? AlignLeft,
		label: t(`builder.align.${align}`),
	}))
);
</script>

<template>
	<ButtonGroup
		:label="t('builder.align.label')"
		:options="groupOptions"
		:value="value"
		@update="(val) => emit('update', val)"
	/>
</template>
