<script setup lang="ts">
import { computed } from 'vue';
import { sanitizeRawHtml } from '@owlat/email-renderer';
import type { EditorBlock, EmailTheme, TextBlockContent } from '../../../types';

const props = defineProps<{
	block: EditorBlock;
	theme: Required<EmailTheme>;
}>();

const content = computed(() => props.block.content as TextBlockContent);

// This preview renders directly into the (non-sandboxed) editor canvas via
// v-html, so author-supplied text HTML must be sanitised here — otherwise a
// stored `<img onerror=…>` would execute in the admin's own session. Mirrors
// the render-boundary sanitiser used for outbound email HTML.
const sanitizedHtml = computed(() =>
	sanitizeRawHtml(content.value.html || '')
	|| '<span style="opacity:0.4">Enter your text here...</span>',
);

const tag = computed(() => {
	const bt = content.value.blockType;
	if (bt === 'h1' || bt === 'h2' || bt === 'h3') return bt;
	return 'div';
});

const styles = computed(() => {
	const c = content.value;
	const t = props.theme;
	const isHeading = tag.value !== 'div';
	return {
		fontSize: `${c.fontSize || t.bodyFontSize || 16}px`,
		color: c.textColor || t.bodyTextColor || '#333333',
		fontFamily: c.fontFamily || t.fontFamily || 'Arial, sans-serif',
		fontWeight: c.fontWeight ? String(c.fontWeight) : 'normal',
		lineHeight: c.lineHeight ? String(c.lineHeight) : '1.5',
		textAlign: c.textAlign || ('left' as const),
		letterSpacing: c.letterSpacing ? `${c.letterSpacing}px` : 'normal',
		textTransform: c.textTransform || 'none',
		textDecoration: c.textDecoration || 'none',
		paddingTop: `${c.paddingTop ?? 16}px`,
		paddingRight: `${c.paddingRight ?? 24}px`,
		paddingBottom: `${c.paddingBottom ?? 16}px`,
		paddingLeft: `${c.paddingLeft ?? 24}px`,
		backgroundColor: c.backgroundColor || 'transparent',
		borderRadius: c.borderRadius ? `${c.borderRadius}px` : undefined,
		marginTop: `${c.marginTop ?? 0}px`,
		marginRight: `${c.marginRight ?? 0}px`,
		marginBottom: `${c.marginBottom ?? 0}px`,
		marginLeft: `${c.marginLeft ?? 0}px`,
		// Headings in the renderer get margin:0; padding:0 reset
		...(isHeading ? { margin: '0', padding: undefined } : {}),
	};
});
</script>

<template>
	<component :is="tag" :style="styles" class="text-preview" v-html="sanitizedHtml" />
</template>

<style scoped>
.text-preview :deep(a) {
	color: inherit;
	text-decoration: underline;
}
.text-preview :deep(.variable-tag),
.text-preview :deep(span[data-variable]) {
	display: inline;
	background: rgba(196, 120, 90, 0.12);
	border: 1px solid rgba(196, 120, 90, 0.3);
	border-radius: 3px;
	padding: 0 3px;
	font-size: 0.9em;
	color: var(--color-brand, #c4785a);
}
</style>
