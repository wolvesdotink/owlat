<script setup lang="ts">
/**
 * Legacy route — desktop settings moved to the standalone /desktop/settings
 * surface (which works without an active workspace). Kept as a redirect so
 * old deep links and muscle memory keep landing somewhere real.
 */
definePageMeta({
	middleware: [() => navigateTo('/desktop/settings', { replace: true })],
});
</script>

<template>
	<div />
</template>
