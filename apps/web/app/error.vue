<script setup lang="ts">
import type { NuxtError } from '#app';

const props = defineProps<{
	error: NuxtError;
}>();

useHead({
	title: `${props.error.statusCode === 404 ? 'Page Not Found' : 'Error'} — Owlat`,
});

const handleGoBack = () => {
	clearError({ redirect: '/' });
};

const statusMessage = computed(() => {
	switch (props.error.statusCode) {
		case 404:
			return "The page you're looking for doesn't exist or has been moved.";
		case 500:
			return 'Something went wrong on our end. Please try again later.';
		case 403:
			return "You don't have permission to access this page.";
		default:
			return props.error.message || 'An unexpected error occurred.';
	}
});
</script>

<template>
	<div class="min-h-screen bg-bg-deep flex flex-col">
		<nav class="flex items-center justify-between px-6 py-4 lg:px-12">
			<NuxtLink to="/" class="font-display text-2xl text-text-primary">Owlat</NuxtLink>
		</nav>

		<main class="flex-1 flex flex-col items-center justify-center px-6 text-center">
			<p class="text-7xl font-display text-brand mb-4">{{ error.statusCode }}</p>
			<h1 class="text-2xl font-semibold text-text-primary mb-3">
				{{ error.statusCode === 404 ? 'Page Not Found' : 'Something Went Wrong' }}
			</h1>
			<p class="text-text-secondary mb-8 max-w-md">
				{{ statusMessage }}
			</p>
			<div class="flex gap-4">
				<button class="btn btn-primary px-6 py-2.5" @click="handleGoBack">Go Home</button>
			</div>
		</main>
	</div>
</template>
