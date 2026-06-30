<script setup lang="ts">
const props = defineProps<{
	html: string;
	minHeight?: string;
}>();

const iframeRef = ref<HTMLIFrameElement | null>(null);
const iframeHeight = ref(props.minHeight ?? '300px');

// Listen for postMessage resize events from the iframe. Only trust messages
// from *our* iframe's content window — any window/extension/origin can post to
// `window`, and without this check a hostile message could drive our layout.
const handleMessage = (event: MessageEvent) => {
	if (event.source !== iframeRef.value?.contentWindow) return;
	if (event.data?.type === 'resize' && typeof event.data.height === 'number') {
		iframeHeight.value = `${event.data.height}px`;
	}
};

onMounted(() => {
	window.addEventListener('message', handleMessage);
});

onUnmounted(() => {
	window.removeEventListener('message', handleMessage);
});

// Inject a resize observer script into the HTML so the iframe reports its own height
const enhancedHtml = computed(() => {
	// Split the closing tag to keep the Vue SFC parser from terminating the outer <script> block early.
	const closeScriptTag = '</' + 'script>';
	const resizeScript = `
<script>
	const resizeObserver = new ResizeObserver(() => {
		const height = document.documentElement.scrollHeight;
		window.parent.postMessage({ type: 'resize', height }, '*');
	});
	resizeObserver.observe(document.body);
	window.parent.postMessage({ type: 'resize', height: document.documentElement.scrollHeight }, '*');
${closeScriptTag}`;

	// Insert the script before </body> or at the end
	if (props.html.includes('</body>')) {
		return props.html.replace('</body>', `${resizeScript}</body>`);
	}
	return props.html + resizeScript;
});
</script>

<template>
	<iframe
		ref="iframeRef"
		:srcdoc="enhancedHtml"
		sandbox="allow-scripts"
		referrerpolicy="no-referrer"
		class="w-full border-0 rounded-lg bg-white"
		:style="{ height: iframeHeight, minHeight: minHeight ?? '200px' }"
	/>
</template>
