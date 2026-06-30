<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick, toRef } from 'vue';
import type { EditorBlock, EmailTheme } from '../../../types';
import { useBlockRenderer } from '../../../composables/useBlockRenderer';

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
		<iframe
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
