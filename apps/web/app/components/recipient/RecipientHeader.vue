<script setup lang="ts">
/**
 * The heading of a recipient-facing page: the sender's name, with what the
 * page is for underneath. Without a name (not configured, or not loaded yet)
 * the purpose becomes the heading — never "Owlat", which the recipient has
 * never heard of and which reads like a phishing tell on an unsubscribe page.
 */
defineProps<{ name: string | null; purpose: string }>();
</script>

<template>
	<header class="w-full max-w-md text-center">
		<template v-if="name">
			<h1 class="font-display text-3xl break-words text-text-primary sm:text-4xl">{{ name }}</h1>
			<p class="mt-2 text-text-secondary">{{ purpose }}</p>
		</template>
		<h1 v-else class="font-display text-3xl text-text-primary sm:text-4xl">{{ purpose }}</h1>
	</header>
</template>
