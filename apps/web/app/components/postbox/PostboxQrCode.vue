<script setup lang="ts">
/**
 * A QR code, drawn as one SVG path (plan idea 54).
 *
 * Encoding lives in `~/utils/postboxQrCode` — pure, dependency-free and unit
 * tested against a round-trip decode; this component only turns the resulting
 * matrix into pixels. It renders nothing when the payload cannot be encoded,
 * because a code that would not scan is worse than no code at all: the caller
 * always shows the fingerprint in text beside it, and that remains the honest
 * fallback.
 *
 * `shape-rendering="crispEdges"` matters — anti-aliased module edges are exactly
 * how a small on-screen code stops being readable by a phone camera.
 */
import { encodeQrMatrix, qrMatrixToSvgPath } from '~/utils/postboxQrCode';

const props = withDefaults(
	defineProps<{
		/** The payload to encode (ASCII; roughly 100 bytes maximum). */
		value: string;
		/** Rendered edge length in pixels. */
		size?: number;
		/** Accessible label — the code itself is decorative to a screen reader. */
		label?: string;
	}>(),
	{ size: 160, label: undefined }
);

const matrix = computed(() => (props.value ? encodeQrMatrix(props.value) : null));
/** Quiet zone in modules; four is the spec's minimum for a reliable scan. */
const QUIET_ZONE = 4;
const extent = computed(() => (matrix.value?.length ?? 0) + QUIET_ZONE * 2);
const path = computed(() => (matrix.value ? qrMatrixToSvgPath(matrix.value, QUIET_ZONE) : ''));
</script>

<template>
	<svg
		v-if="matrix"
		:width="size"
		:height="size"
		:viewBox="`0 0 ${extent} ${extent}`"
		shape-rendering="crispEdges"
		role="img"
		:aria-label="label"
		data-testid="qr-code"
	>
		<!-- The light modules and the quiet zone are one rect; a scanner needs the
		     margin to be the same white as the code, not the page background. -->
		<rect :width="extent" :height="extent" fill="#ffffff" />
		<path :d="path" fill="#000000" />
	</svg>
</template>
