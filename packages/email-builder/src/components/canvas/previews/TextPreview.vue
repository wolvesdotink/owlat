<script setup lang="ts">
import { computed } from 'vue';
import { sanitizeRawHtml, moduleFor } from '@owlat/email-renderer';
import type { EditorBlock, EmailTheme, TextBlockContent } from '../../../types';
import { blockBoxStyle } from '../../../utils/blocks';

const props = defineProps<{
	block: EditorBlock;
	theme: Required<EmailTheme>;
}>();

// Run the renderer module's applyTheme so the canvas shows the same
// heading/body theme defaults the Walker folds in at render time — otherwise
// edit and preview drift apart on themed typography.
const content = computed(() => {
	const raw = props.block.content as TextBlockContent;
	const applied = moduleFor('text')?.applyTheme?.(raw as never, props.theme);
	return (applied as TextBlockContent | undefined) ?? raw;
});

// This preview renders directly into the (non-sandboxed) editor canvas via
// v-html, so author-supplied text HTML must be sanitised here — otherwise a
// stored `<img onerror=…>` would execute in the admin's own session. Mirrors
// the render-boundary sanitiser used for outbound email HTML.
const sanitizedHtml = computed(
	() =>
		sanitizeRawHtml(content.value.html || '') ||
		'<span style="opacity:0.4">Enter your text here...</span>'
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
		// The renderer emits a bare <h1>-<h3> when fontWeight is unset, which
		// email clients render at the UA-default bold — mirror that here.
		fontWeight: c.fontWeight ? String(c.fontWeight) : isHeading ? 'bold' : 'normal',
		lineHeight: c.lineHeight ? String(c.lineHeight) : '1.5',
		textAlign: c.textAlign || ('left' as const),
		letterSpacing: c.letterSpacing ? `${c.letterSpacing}px` : 'normal',
		textTransform: c.textTransform || 'none',
		textDecoration: c.textDecoration || 'none',
		backgroundColor: c.backgroundColor || 'transparent',
		borderRadius: c.borderRadius ? `${c.borderRadius}px` : undefined,
		// The explicit margin longhands from blockBoxStyle double as the heading
		// UA-margin reset: the renderer zeroes the <h*> tag's own margin and
		// folds these values into the section padding, so the net box is identical.
		...blockBoxStyle({ content: c }),
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
</style>
