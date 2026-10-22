<script setup lang="ts">
/**
 * The pencil on a thread or room row that holds the viewer's unsent draft on
 * this device. Not colour alone: the name is in the tooltip and for screen
 * readers.
 */
const { t } = useI18n();
</script>

<template>
	<span
		class="inline-flex shrink-0 items-center text-text-tertiary"
		:title="t('components.shell.draftMarker.label')"
		data-testid="draft-marker"
	>
		<Icon name="lucide:pencil" class="size-3" aria-hidden="true" />
		<span class="sr-only">{{ t('components.shell.draftMarker.label') }}</span>
	</span>
</template>
