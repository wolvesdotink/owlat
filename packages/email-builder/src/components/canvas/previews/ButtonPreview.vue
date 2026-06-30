<script setup lang="ts">
import { computed } from 'vue';
import type { EditorBlock, EmailTheme, ButtonBlockContent } from '../../../types';
import { gradientCss as buildGradientCss } from '../../../utils/gradient';

const props = defineProps<{
	block: EditorBlock;
	theme: Required<EmailTheme>;
}>();

const content = computed(() => props.block.content as ButtonBlockContent);

const wrapperStyles = computed(() => ({
	textAlign: (content.value.align === 'full' ? 'center' : content.value.align) || ('center' as const),
	paddingTop: `${content.value.paddingTop ?? 16}px`,
	paddingRight: `${content.value.paddingRight ?? 24}px`,
	paddingBottom: `${content.value.paddingBottom ?? 16}px`,
	paddingLeft: `${content.value.paddingLeft ?? 24}px`,
	marginTop: `${content.value.marginTop ?? 0}px`,
	marginRight: `${content.value.marginRight ?? 0}px`,
	marginBottom: `${content.value.marginBottom ?? 0}px`,
	marginLeft: `${content.value.marginLeft ?? 0}px`,
}));

const gradientCss = computed(() => buildGradientCss(content.value.backgroundGradient));

const buttonStyles = computed(() => {
	const c = content.value;
	const isFullWidth = c.fullWidth || c.align === 'full';

	const bgColor = c.backgroundColor || props.theme.primaryColor;
	const background = gradientCss.value || bgColor;

	// Use buttonBorderWidth/Style/Color (distinct from section border)
	const hasBorder = c.buttonBorderWidth && c.buttonBorderWidth > 0 && c.buttonBorderStyle !== 'none';

	return {
		display: isFullWidth ? 'block' : 'inline-block',
		width: isFullWidth ? '100%' : (c.buttonWidth || undefined),
		backgroundColor: gradientCss.value ? undefined : bgColor,
		background: gradientCss.value || undefined,
		color: c.textColor || '#ffffff',
		fontFamily: c.fontFamily || props.theme.fontFamily || 'Arial, sans-serif',
		fontSize: `${c.fontSize || 16}px`,
		fontWeight: c.fontWeight ? String(c.fontWeight) : 'inherit',
		textDecoration: 'none',
		borderRadius: `${c.borderRadius ?? 8}px`,
		padding: `${c.paddingY ?? 12}px ${c.paddingX ?? 24}px`,
		border: hasBorder
			? `${c.buttonBorderWidth}px ${c.buttonBorderStyle || 'solid'} ${c.buttonBorderColor || '#000000'}`
			: 'none',
		textAlign: 'center' as const,
		cursor: 'default',
		letterSpacing: c.letterSpacing ? `${c.letterSpacing}px` : undefined,
		textTransform: c.textTransform || undefined,
		boxSizing: 'border-box' as const,
	};
});
</script>

<template>
	<div :style="wrapperStyles">
		<span :style="buttonStyles">{{ content.text || 'Click here' }}</span>
	</div>
</template>
