<script setup lang="ts">
// Shown on the builder routes below `md` (see useEmailBuilderViewport). The
// canvas needs its block palette and inspector alongside it, so a phone gets an
// honest explanation and a way out instead of an unusable editor.
const { t } = useI18n();
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
			<h2 class="text-xl font-semibold text-text-primary">
				{{ t('components.email.emailBuilderViewportGate.title') }}
			</h2>
			<p class="text-text-secondary mt-2">
				{{ t('components.email.emailBuilderViewportGate.body') }}
			</p>
			<div class="mt-6 flex flex-col items-center gap-3">
				<slot name="action" />
			</div>
		</div>
	</div>
</template>
