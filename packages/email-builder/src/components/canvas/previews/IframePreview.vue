<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick, toRef } from 'vue';
import { FileCode2 } from '@lucide/vue';
import type { EditorBlock, EmailTheme } from '../../../types';
import { useBlockRenderer } from '../../../composables/useBlockRenderer';
import { getBlock } from '../../../registry';

const props = defineProps<{
	block: EditorBlock;
	theme: Required<EmailTheme>;
}>();

const iframeRef = ref<HTMLIFrameElement | null>(null);
const iframeHeight = ref(60);

const blockRef = toRef(props, 'block');
const { html: renderedHtml } = useBlockRenderer(blockRef, {
	theme: toRef(props, 'theme'),
	debounceMs: 100,
});

// The renderer skips content-less blocks entirely (a video without a URL, a
// carousel without images, raw HTML that is only a comment render to '').
// That is correct for the sent email, but on the canvas it left an invisible,
// unclickable sliver — show a labelled placeholder instead so the block stays
// discoverable and configurable.
const isEmpty = computed(() => {
	const html = renderedHtml.value?.trim() ?? '';
	if (!html) return true;
	// Wrapper-only output (e.g. rawHtml holding just a comment): no text and no
	// visible elements inside.
	const stripped = html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<\/?(?:table|tbody|tr|td|div|center)[^>]*>/gi, '')
		.trim();
	return stripped === '';
});

const blockLabel = computed(() => getBlock(props.block.type)?.label ?? props.block.type);

const srcdoc = computed(() => {
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
body { margin: 0; padding: 0; overflow: hidden; }
* { box-sizing: border-box; }
</style>
</head>
<body>${renderedHtml.value}</body>
</html>`;
});

function resizeIframe() {
	if (!iframeRef.value) return;
	try {
		const body = iframeRef.value.contentDocument?.body;
		if (body) {
			iframeHeight.value = Math.max(body.scrollHeight, 20);
		}
	} catch {
		// cross-origin safety
	}
}

watch(srcdoc, () => {
	nextTick(() => {
		setTimeout(resizeIframe, 50);
	});
});

onMounted(() => {
	if (iframeRef.value) {
		iframeRef.value.addEventListener('load', resizeIframe);
	}
});
</script>

<template>
	<div class="relative">
		<div
			v-if="isEmpty"
			class="flex flex-col items-center justify-center gap-2 h-[120px] m-2 bg-bg-surface border-2 border-dashed border-border-subtle rounded-lg text-text-tertiary"
		>
			<FileCode2 :size="24" />
			<span class="text-xs">{{ blockLabel }} — select to configure</span>
		</div>
		<iframe
			v-else
			ref="iframeRef"
			class="block w-full border-none pointer-events-none"
			:srcdoc="srcdoc"
			sandbox="allow-same-origin"
			:style="{ height: `${iframeHeight}px` }"
			frameborder="0"
			scrolling="no"
		/>
	</div>
</template>
