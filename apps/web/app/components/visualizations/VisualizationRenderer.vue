<script setup lang="ts">
const props = defineProps<{
	html: string;
	minHeight?: string;
}>();

const iframeRef = ref<HTMLIFrameElement | null>(null);
const iframeHeight = ref(props.minHeight ?? '300px');

/**
 * Tallest the frame may grow. The height the frame reports feeds back into its
 * own layout (content sized in `vh` or `%` grows with the frame), so without a
 * ceiling that loop never settles and the card keeps growing.
 */
const MAX_VISUALIZATION_HEIGHT = 4000;
let lastReported: number | null = null;

// Listen for postMessage resize events from the iframe. Only trust messages
// from *our* iframe's content window — any window/extension/origin can post to
// `window`, and without this check a hostile message could drive our layout.
const handleMessage = (event: MessageEvent) => {
	if (event.source !== iframeRef.value?.contentWindow) return;
	if (event.data?.type !== 'resize') return;
	const reported = event.data.height;
	if (typeof reported !== 'number' || !Number.isFinite(reported) || reported <= 0) return;
	// Sub-pixel jitter would otherwise re-lay out the card on every report.
	if (lastReported !== null && Math.abs(reported - lastReported) < 1) return;
	lastReported = reported;
	iframeHeight.value = `${Math.min(MAX_VISUALIZATION_HEIGHT, Math.ceil(reported))}px`;
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
(() => {
	let lastReported = -1;
	const report = () => {
		const height = document.documentElement.scrollHeight;
		if (Math.abs(height - lastReported) < 1) return;
		lastReported = height;
		window.parent.postMessage({ type: 'resize', height }, '*');
	};
	new ResizeObserver(report).observe(document.body);
	report();
})();
${closeScriptTag}`;

	// Insert the script before </body> or at the end
	if (props.html.includes('</body>')) {
		return props.html.replace('</body>', `${resizeScript}</body>`);
	}
	return props.html + resizeScript;
});
</script>

<template>
	<!-- palette-ok: literal white, not a surface token — the agent generates
	     visualization markup against a fixed light palette (dark text, no
	     background of its own), so the canvas must stay light in both app themes. -->
	<iframe
		ref="iframeRef"
		:srcdoc="enhancedHtml"
		sandbox="allow-scripts"
		referrerpolicy="no-referrer"
		class="w-full border-0 rounded-lg bg-white"
		:style="{ height: iframeHeight, minHeight: minHeight ?? '200px' }"
	/>
</template>
