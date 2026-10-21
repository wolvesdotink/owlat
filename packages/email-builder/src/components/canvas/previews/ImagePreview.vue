<script setup lang="ts">
import { computed } from 'vue';
import type { EditorBlock, EmailTheme, ImageBlockContent } from '../../../types';
import { blockBoxStyle } from '../../../utils/blocks';
import { ImageIcon } from '@lucide/vue';
import { useBuilderI18n } from '../../../i18n/useBuilderI18n';

const { t } = useBuilderI18n();

const props = defineProps<{
	block: EditorBlock;
	theme: Required<EmailTheme>;
}>();

const content = computed(() => props.block.content as ImageBlockContent);

const wrapperStyles = computed(() => ({
	textAlign: content.value.align || ('center' as const),
	...blockBoxStyle(props.block),
}));

const imgStyles = computed(() => ({
	width: content.value.width ? `${content.value.width}%` : '100%',
	maxWidth: '100%',
	height: content.value.height ? `${content.value.height}px` : 'auto',
	display: 'inline-block',
	borderRadius: content.value.borderRadius ? `${content.value.borderRadius}px` : undefined,
}));
</script>

<template>
	<div :style="wrapperStyles">
		<img
			v-if="content.src"
			:src="content.src"
			:alt="content.alt || ''"
			:style="imgStyles"
		/>
		<div
			v-else
			class="inline-flex flex-col items-center justify-center gap-2 bg-bg-surface border-2 border-dashed border-border-subtle rounded-lg text-text-tertiary"
			:style="{ width: content.width ? `${content.width}%` : '100%', height: '120px' }"
		>
			<ImageIcon :size="24" />
			<span class="text-xs">{{ t('builder.canvas.preview.noImage') }}</span>
		</div>
	</div>
</template>
