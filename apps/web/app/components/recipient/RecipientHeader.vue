<script setup lang="ts">
import type { RecipientLogo } from '~/composables/useRecipientSender';
import WorkspaceLogo from '~/components/workspace/WorkspaceLogo.vue';

/**
 * The heading of a recipient-facing page: the sender's logo and name, with
 * what the page is for underneath. Without a name (not configured, or not
 * loaded yet) the purpose becomes the heading — never "Owlat", which the
 * recipient has never heard of and which reads like a phishing tell on an
 * unsubscribe page. Without a logo there is simply no logo (#810).
 */
defineProps<{ name: string | null; purpose: string; logo?: RecipientLogo | null }>();
</script>

<template>
	<header class="w-full max-w-md text-center">
		<WorkspaceLogo v-if="logo" :url="logo.url" :dark-url="logo.darkUrl" class="mb-4" />
		<template v-if="name">
			<h1 class="font-display text-3xl break-words text-text-primary sm:text-4xl">{{ name }}</h1>
			<p class="mt-2 text-text-secondary">{{ purpose }}</p>
		</template>
		<h1 v-else class="font-display text-3xl text-text-primary sm:text-4xl">{{ purpose }}</h1>
	</header>
</template>
