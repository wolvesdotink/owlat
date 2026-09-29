<script setup lang="ts">
// Chrome-less layout for the dedicated desktop compose window.
import { UNDO_TOAST_REGION_ID } from '~/utils/undoToastRegion';
</script>

<template>
	<div class="min-h-dvh bg-bg-base text-text-primary">
		<slot />
		<!-- The undo countdown toasts teleport here (see layouts/dashboard.vue). -->
		<div :id="UNDO_TOAST_REGION_ID" class="fixed bottom-4 left-4 z-50 flex flex-col gap-2" />
	</div>
</template>
