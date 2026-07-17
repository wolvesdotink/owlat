<script setup lang="ts">
/**
 * The lazy-load placeholder shown while a plugin task-card's component is being
 * fetched. A real single-file component (not a runtime `template` string) so it
 * is compiled at build time and works under Nuxt's runtime-only Vue in SSR and
 * production. Explicitly imported by TaskCardRenderer.
 */
</script>

<template>
	<div class="p-8 text-center" role="status" aria-label="Loading task">
		<UiSpinner class="mx-auto" />
	</div>
</template>
