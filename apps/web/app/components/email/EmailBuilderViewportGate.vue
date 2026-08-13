<script setup lang="ts">
// Shown on the builder routes below `md` (see useEmailBuilderViewport). The
// canvas needs its block palette and inspector alongside it, so a phone gets an
// honest explanation and a way out instead of an unusable editor.
</script>

<template>
	<div class="h-full flex items-center justify-center bg-bg-deep p-6">
		<div class="max-w-sm text-center">
			<UiIconBox
				icon="lucide:monitor"
				size="xl"
				variant="surface"
				rounded="full"
				class="mb-4 mx-auto"
			/>
			<h2 class="text-xl font-semibold text-text-primary">The editor needs a bigger screen</h2>
			<p class="text-text-secondary mt-2">
				Drag-and-drop editing doesn't fit on a phone. Open this on a tablet or desktop to make
				changes — everything you've saved is exactly as you left it.
			</p>
			<div class="mt-6 flex flex-col items-center gap-3">
				<slot name="action" />
			</div>
		</div>
	</div>
</template>
