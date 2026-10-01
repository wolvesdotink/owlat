<script setup lang="ts">
/**
 * A small, read-only render of a campaign's email body, as the Review step's
 * "this is what recipients get" check. The email is laid out at desktop width;
 * a narrower container shrinks the whole render instead of cropping it, so a
 * phone still sees the layout. The editor's own preview is where it gets
 * worked on.
 */
defineProps<{ html: string; title: string }>();

/** The width the email is laid out at, a little over the usual 600px body. */
const EMAIL_WIDTH = 640;
/** The visible slice of the email at full scale; the frame scrolls past it. */
const FRAME_HEIGHT = 360;

const container = ref<HTMLElement | null>(null);
const scale = ref(1);
let observer: ResizeObserver | null = null;

onMounted(() => {
	const element = container.value;
	if (!element || typeof ResizeObserver === 'undefined') return;
	observer = new ResizeObserver(([entry]) => {
		const width = entry?.contentRect.width ?? EMAIL_WIDTH;
		scale.value = Math.min(1, width / EMAIL_WIDTH);
	});
	observer.observe(element);
});

onBeforeUnmount(() => observer?.disconnect());

const frameStyle = computed(() =>
	scale.value < 1
		? {
				width: `${EMAIL_WIDTH}px`,
				height: `${FRAME_HEIGHT}px`,
				transform: `scale(${scale.value})`,
				transformOrigin: 'top left',
			}
		: { width: '100%', height: `${FRAME_HEIGHT}px` }
);
</script>

<template>
	<!--
		The email was authored for a light canvas, so the paper stays light in
		both color schemes (`light` re-resolves the token layer for this subtree,
		`scheme-only-light` keeps the frame off the dark preference).
	-->
	<div
		ref="container"
		class="light overflow-hidden rounded-lg border border-border-subtle bg-surface-3"
		:style="{ height: `${Math.round(FRAME_HEIGHT * scale)}px` }"
	>
		<!--
			An empty sandbox: no scripts, no same-origin access, no forms. The
			frame only has to paint the HTML.
		-->
		<iframe
			:srcdoc="html"
			sandbox=""
			:title="title"
			class="block border-0 scheme-only-light"
			:style="frameStyle"
			data-testid="campaign-email-preview"
		/>
	</div>
</template>
