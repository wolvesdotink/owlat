<script setup lang="ts">
interface Props {
	icon?: string;
	title: string;
	description?: string;
}

defineProps<Props>();
</script>

<template>
	<div class="flex flex-col items-center justify-center py-16 text-center px-6">
		<!-- Icon Container -->
		<UiIconBox v-if="icon" :icon="icon" size="xl" variant="surface" rounded="2xl" class="mb-4" />

		<!-- Title -->
		<p class="text-lg font-semibold text-text-primary mb-2">{{ title }}</p>

		<!-- Description -->
		<p v-if="description" class="text-text-secondary mb-6 max-w-sm">{{ description }}</p>

		<!-- Action Slot -->
		<slot name="action" />
	</div>
</template>
